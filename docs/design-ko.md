# 웹(CDP) 디버깅 확장 설계 — AI-Dico/necto 포크

작성 2026-11-13 · 상태: 제안(결정 대기)

## 목표

Necto 한 화면에서 모바일 앱(iOS·Android)과 웹 페이지(Chrome·안채·Electron)를
같이 본다. 원본 Necto 의 디버깅 대상은 모바일 앱뿐이다(usbmuxd·loopback·adb).

## 실측한 사실 (2026-11-13, 맥북, Necto 0.3.0 main `0d428ff` 직접 빌드)

시험 플러그인 `cdp-probe`(데스크톱 플러그인, 권한 없음)를 설치하고
headless Chrome 157(`--remote-debugging-port=9333 --remote-allow-origins='*'`)에 붙였다.

| 시험 | 결과 |
|---|---|
| 패널 origin | `necto-plugin://<principal>`, `isSecureContext=true` |
| 패널 → CORS 헤더 주는 로컬 서버 fetch(127.0.0.1·localhost) | 성공. 서버가 받은 Origin = 패널 origin |
| 패널 → Chrome `/json/version`·`/json/list` fetch | 실패 — Chrome 응답에 CORS 헤더 없음 |
| 패널 → `ws://localhost:9333/devtools/page/<id>` | 성공, `Runtime.evaluate("1+1")` → `2` |
| 패널 → `ws://127.0.0.1:9333/devtools/page/<id>` | 실패(close 1006), 2회 재현. 원인 미확인 |

문서로 확인한 제약(`docs/ko/plugin-manifest.md`, `docs/ko/bridges.md`):

- 데스크톱 플러그인의 오퍼레이션은 맥 앱이 제공하는 `necto.desktop.*` 브리지
  (스토리지·타깃·셸·알림·정보)에만 바인딩할 수 있다. 패널 JS 의 기능을
  CLI·에이전트용 오퍼레이션으로 내보낼 길이 없다.
- 패널 웹뷰의 fetch·WebSocket 은 `allowedOrigins` 로 막지 않는다.
- 셸 브리지(`necto.desktop.shell.*`)는 데스크톱 플러그인만, 사용자 승인 뒤 쓸 수 있다.
- AGENTS.md: 「맥 쪽 코드가 따로 필요한 플러그인은 잘못 설계된 것」. 맥 쪽에
  CDP 전용 코드를 넣으면 upstream 이 받지 않는다.

## 선택지

### A. 데스크톱 플러그인 「Web」 (권장, 1단계)

```
Web 패널(JS) ──WebSocket──▶ ws://localhost:<port>/devtools/page/<id>  (Chrome·안채·Electron)
      └─ 대상 찾기: necto.desktop.shell 로 `curl -s localhost:<port>/json/list` (승인 1회)
      └─ 설정 저장: necto.desktop.storage (포트 목록·최근 대상)
```

- 탭 목록 → 탭 고르기 → Network(`Network.*`)·Console(`Runtime.consoleAPICalled`,
  `Log.entryAdded`)·Performance(`Performance.getMetrics`)·Storage(`DOMStorage`, 쿠키) 패널.
- 화면은 기존 Network·Performance 패널과 같은 디자인 토큰·같은 표 모양을 쓴다.
- 맥 앱·SDK 무수정이라 upstream 을 그대로 따라갈 수 있다. 별도 저장소로 배포 가능
  (`necto install AI-Dico/necto-web`).
- 한계: CLI·에이전트에서 부를 수 없다(화면 전용). 대상 브라우저는
  `--remote-debugging-port` 와 `--remote-allow-origins` 를 켜고 실행해야 한다.
- 한계 보완: 에이전트용 웹 조작은 이미 안채 MCP(CDP 9339)가 한다. 겹치게 만들 필요가 없다.

### B. 맥 쪽 「브라우저 타깃」 프로바이더 (2단계, 필요할 때만)

```
NectoMacService
  ├ usbmuxd / loopback / adb   (기존)
  └ CDP 연결기 (신규) — 탭 하나 = 타깃 하나
       기존 브리지 이름에 CDP 를 대응:
       necto.device.network-records.*  ← Network.requestWillBeSent/responseReceived
       necto.device.performance.*      ← Performance.getMetrics
       control.*                       ← Accessibility.getFullAXTree / Input.dispatch*
```

- 기존 Network·Performance·Control 패널과 `necto-cli` 가 웹 탭에서도 그대로 동작.
- 대가: 맥 코어 변경 → upstream 과 갈라짐(받아 주지 않을 구조). 1~2주 + 계속 합치는 부담.

### C. 웹 SDK(JS 라이브러리를 웹 앱에 넣기) — 비권장

- 브라우저는 소켓을 열고 기다릴 수 없어 「앱이 열고 맥이 붙는」 구조가 깨진다.
  맥 쪽에 WebSocket 서버가 필요해 「서버 프로세스 없음」 원칙과 충돌.
- 장점은 Safari·모바일 브라우저까지 된다는 것 하나.

## 권장

1. A 로 시작한다. CDP → 화면 대응 코드(TS)는 B 에서 다시 쓸 수 있게 모듈로 분리한다
   (`cdp-mapping/network.ts` 가 Necto 네트워크 레코드 스키마로 변환).
2. CLI·에이전트에서 웹 탭을 Necto 로 다뤄야 할 일이 반복되면 B 를 포크에서만 한다.

## 첫 작업 단위 (A)

1. `create-necto-plugin Web --type desktop` 으로 뼈대.
2. 대상 찾기: 포트 입력(기본 9222) → 셸 브리지로 `/json/list` → 탭 목록.
3. Network 패널: 요청 표(상태·메서드·URL·시간·크기) + 상세(헤더·본문 `Network.getResponseBody`).
4. Console 패널, Performance 패널 순.
5. 시험: headless Chrome 을 띄우는 E2E 1개(맥미니), CDP 대응 코드 단위 시험.

## 열린 질문

- `ws://127.0.0.1` 만 1006 으로 끊기는 원인(WebKit 쪽인지 Chrome 쪽인지). 당장은 localhost 로 우회.
- ~~안채 CDP(9339)가 패널 origin 을 허용하는지~~ → 2026-11-13 실측: 허용하지 않는다. 안채는 `--remote-allow-origins` 를 항상 지운다(`cef/app/src/cdp_auth.cc` `Enforce()`), 패널 origin 은 403. 안채를 대상으로 하려면 안채 쪽에 사용자 승인형 허용 출처 설정이 필요하다(보안 경로, 안채 작업으로 분리).
