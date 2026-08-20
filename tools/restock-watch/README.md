# 재입고 감시기 (restock-watch)

쿠팡 상품이 **품절 → 판매중**으로 바뀌는 순간을 잡아서 카카오톡·슬랙으로 알려준다.
생크림처럼 들어왔다가 몇 시간 만에 빠지는 품목을 놓치지 않으려고 만들었다.

의존성 없음. Node 18 이상이면 바로 돈다.

## 이 도구가 하는 일 / 안 하는 일

**한다**
- 상품 페이지를 정해진 주기로 확인
- 품절 → 판매중 전환을 감지
- 카카오톡(나에게 보내기) / 슬랙 / 디스코드 / 웹훅 / 로컬 명령으로 즉시 알림
- 알림에 바로 구매 링크와 현재 가격을 같이 실어 보냄
- 목표가 이하로 떨어졌을 때 알림 (선택)

**안 한다**
- 로그인, 장바구니 담기, 결제. **구매는 사람이 직접 한다.**

결제까지 자동으로 돌리지 않는 이유는 셋이다. 쿠팡 이용약관이 자동화된 수단의
접근을 금지하고 있어 계정이 정지될 수 있고, 스크립트에 아이디·비밀번호·결제수단을
저장해야 하며, 오작동하면 원치 않는 주문이 그대로 결제된다.
품절템은 결국 **알림을 몇 초 안에 받느냐**가 승부라서, 알림을 확실하게 받고
휴대폰에서 두 번 눌러 사는 쪽이 실제로 더 안전하고 빠르다.

## 빠른 시작

```bash
cd tools/restock-watch

# 1. 단축링크에서 진짜 상품 URL 뽑기
node watch.js resolve https://link.coupang.com/a/gm5wpJlfCS

# 2. 설정 파일 만들기
cp targets.example.json targets.json
#    targets.json 을 열어 위에서 나온 url 을 넣고, notify 채널을 하나 켠다

# 3. 알림 채널이 살아 있는지 확인
node watch.js notify-test

# 4. 1회 검사
node watch.js check

# 5. 상주 감시
node watch.js watch
```

## 명령

| 명령 | 설명 |
|---|---|
| `node watch.js check` | 1회 검사하고 종료. cron 에 걸 때 쓴다 |
| `node watch.js watch` | 주기적으로 계속 검사 |
| `node watch.js resolve <단축링크>` | `link.coupang.com` 링크에서 productId 추출 |
| `node watch.js dump <url> [-o 파일]` | 받아온 HTML 저장 + 판정 결과 출력 |
| `node watch.js notify-test` | 알림 채널만 시험 발송 |
| `node watch.js selftest` | 회귀 테스트 (`node test.js` 와 같음) |

옵션: `--config <경로>` `--state <경로>` `--browser`

## 설정 (`targets.json`)

```jsonc
{
  "intervalSeconds": 300,     // 검사 주기. 60초 미만은 강제로 60초로 올린다
  "jitterSeconds": 60,        // 주기를 ±60초 흔든다. 정확히 일정한 요청은 눈에 띈다
  "timeoutMs": 15000,
  "retries": 2,

  "notify": {
    "kakao": {
      "enabled": true,
      "accessToken": "env:KAKAO_ACCESS_TOKEN",
      "restApiKey":  "env:KAKAO_REST_API_KEY",   // 토큰 자동 갱신용
      "refreshToken": "env:KAKAO_REFRESH_TOKEN"
    },
    "slack": { "enabled": false, "webhookUrl": "env:SLACK_WEBHOOK_URL" }
  },

  "targets": [
    {
      "id": "seoulmilk-cream",
      "name": "서울우유 생크림",
      "url": "https://www.coupang.com/vp/products/1234567890?itemId=...&vendorItemId=...",
      "shortUrl": "https://link.coupang.com/a/gm5wpJlfCS",  // 알림에 실어 보낼 링크
      "maxPrice": 9000,          // 이 값 이하로 떨어지면 price_drop. 안 쓰면 null
      "notifyOn": ["restock", "available"],
      "cooldownMinutes": 120     // 같은 종류 알림을 이 시간 안에는 다시 안 보낸다
    }
  ]
}
```

`"env:NAME"` 으로 적으면 환경변수에서 읽는다. 토큰을 파일에 직접 쓰지 않아도 된다.

`targets.json` 과 `state.json` 은 `.gitignore` 에 들어 있다. 커밋되지 않는다.

### 알림 종류 (`notifyOn`)

| 값 | 언제 |
|---|---|
| `restock` | 품절이었다가 판매중으로 바뀜 ← **핵심** |
| `available` | 감시를 처음 시작했는데 이미 판매중 |
| `price_drop` | 목표가 위에 있다가 아래로 내려옴 |
| `soldout` | 판매중이었다가 품절 |
| `gone` | 상품 페이지가 사라짐 (404) |

## 카카오톡 알림 설정

카카오 "나에게 보내기"는 무료고 앱 푸시로 바로 온다.

1. [developers.kakao.com](https://developers.kakao.com) → 내 애플리케이션 → 추가
2. **앱 키**에서 REST API 키 복사
3. **카카오 로그인** 활성화 → Redirect URI 에 `https://localhost` 등록
4. **동의항목** → `카카오톡 메시지 전송(talk_message)` 을 "선택 동의"로 켜기
5. 브라우저에서 아래 주소를 열고 동의 → 리다이렉트된 주소창의 `code=` 값 복사

   ```
   https://kauth.kakao.com/oauth/authorize?client_id=REST_API_KEY&redirect_uri=https://localhost&response_type=code&scope=talk_message
   ```

6. 토큰 교환

   ```bash
   curl -X POST https://kauth.kakao.com/oauth/token \
     -d grant_type=authorization_code \
     -d client_id=REST_API_KEY \
     -d redirect_uri=https://localhost \
     -d code=위에서_복사한_코드
   ```

7. 나온 값을 환경변수로

   ```bash
   export KAKAO_REST_API_KEY=...
   export KAKAO_ACCESS_TOKEN=...
   export KAKAO_REFRESH_TOKEN=...
   ```

액세스 토큰은 6시간이면 만료된다. `restApiKey` 와 `refreshToken` 을 넣어두면
만료를 감지해서 알아서 새로 받는다. 리프레시 토큰이 갱신되면 콘솔에 새 값을
찍어주니 환경변수를 바꿔두면 된다. (리프레시 토큰 자체는 두 달간 유효)

## 디스코드 알림 설정

가장 손이 덜 간다. 토큰 발급 절차 없이 웹훅 URL 하나면 끝난다.

1. 디스코드에서 알림 받을 채널 → **채널 편집 → 연동 → 웹후크 → 새 웹후크**
2. **웹후크 URL 복사**
3. 환경변수로 넣는다 (설정 파일에 직접 쓰지 말 것)

   ```bash
   export DISCORD_WEBHOOK_URL='https://discord.com/api/webhooks/...'
   ```

4. `targets.json` 의 `notify.discord.enabled` 를 `true` 로

   ```jsonc
   "discord": {
     "enabled": true,
     "webhookUrl": "env:DISCORD_WEBHOOK_URL",
     "username": "재입고 감시기",
     "mention": "@here",                                      // 생략하면 멘션 없음
     "mentionOn": ["restock", "available", "price_drop", "test"]
   }
   ```

5. `node watch.js notify-test` 로 확인

알림은 임베드로 나가고 이벤트별로 색이 다르다.
재입고·구매가능은 초록, 가격 하락은 파랑, 품절 전환은 회색, 페이지 삭제는 빨강.
제목을 누르면 바로 상품 페이지로 간다.

**멘션은 지금 살 수 있는 알림에만 붙는다.** 품절 전환까지 `@here` 가 울리면
며칠 만에 채널 알림을 꺼버리게 되기 때문이다. 바꾸려면 `mentionOn` 에 직접 적으면 된다.

상품명에 `@everyone` 같은 문자열이 섞여 들어와도 멘션으로 터지지 않게
`allowed_mentions` 로 막아둔다. 웹훅이 레이트리밋(429)에 걸리면 서버가 알려준
시간만큼 쉬었다가 한 번 재시도한다.

> 웹훅 URL은 비밀번호와 같다. 이 URL을 아는 사람은 누구나 해당 채널에 글을 쓸 수 있다.
> 공개된 곳에 노출됐다면 디스코드에서 웹후크를 삭제하고 새로 만들면 된다.

## 백그라운드로 돌리기

### cron (리눅스 / 맥) — 5분마다 1회 검사

```cron
*/5 * * * * cd /경로/tools/restock-watch && /usr/bin/node watch.js check >> watch.log 2>&1
```

`check` 는 상태를 `state.json` 에 남기므로 cron 으로 띄엄띄엄 돌려도 전환을 놓치지 않는다.

### systemd (상주)

```ini
[Unit]
Description=coupang restock watch
After=network-online.target

[Service]
WorkingDirectory=/경로/tools/restock-watch
Environment=KAKAO_REST_API_KEY=...
Environment=KAKAO_REFRESH_TOKEN=...
ExecStart=/usr/bin/node watch.js watch
Restart=always
RestartSec=30

[Install]
WantedBy=multi-user.target
```

## 쿠팡이 막을 때

쿠팡은 브라우저가 아닌 요청을 자주 거절한다. `차단됨(403)` 이 계속 뜨면:

1. **주기를 늘린다.** 300초 이상 권장. 짧게 때릴수록 빨리 막힌다.
2. **실제 브라우저로 받는다.**

   ```bash
   npm i playwright && npx playwright install chromium
   node watch.js watch --browser
   ```

3. 집 인터넷(가정용 IP)에서 돌린다. 클라우드 서버 IP는 더 잘 막힌다.

차단/판정불가 회차는 **상태를 덮어쓰지 않는다.** 차단을 "품절"로 기록해버리면
다음에 정상 응답이 왔을 때 가짜 재입고 알림이 나가기 때문이다.

## 쿠팡이 페이지 구조를 바꿨을 때

`판정불가` 가 5회 연속 뜨면 경고를 찍는다. 그때는:

```bash
node watch.js dump "https://www.coupang.com/vp/products/..." -o dump.html
```

`dump.html` 을 열어 품절/판매중 표시가 어떤 마크업으로 바뀌었는지 확인하고,
`watch.js` 위쪽의 `SIGNALS` 배열에 규칙을 추가하거나 고친다. 그다음:

```bash
node test.js
```

### 판정 방식

셀렉터 하나에 걸지 않고 여러 신호에 가중치를 매겨서 센 쪽을 택한다.
JSON-LD 의 `availability`(100) 가 가장 믿을 만하고, 버튼 텍스트(65~70)가 가장 약하다.
양쪽 신호 세기 차이가 15 미만이면 **판정을 포기하고 알림을 보내지 않는다.**
품절인데 og 메타만 `instock` 으로 남아 있는 페이지가 있어서, 근소한 우세로
"재입고!" 를 쏘면 헛걸음을 시키게 된다.

## 참고: 생크림을 안정적으로 받는 다른 방법

감시기와 별개로, 매장에서 상시로 쓰는 재료라면 소매 채널 하나에 의존하지 않는 편이 낫다.

- **쿠팡 정기배송** — 같은 상품에 정기배송이 열려 있으면 일반 판매분보다 물량이 따로 잡힌다
- **서울우유 대리점 직거래** — 지역 대리점과 거래를 트면 소매 품절과 무관하게 들어온다. 단가도 낮다
- **식자재 도매 (식자재왕, 베이킹 재료 전문 쇼핑몰)** — 업소용 1L 단위가 소매보다 안정적이다
- **대체 가능한 규격을 같이 감시** — 500ml 이 품절이어도 1L 이나 타사 제품은 남아 있는 경우가 많다.
  `targets` 배열에 여러 개를 넣어두면 된다

## 주의

- 검사 주기를 지나치게 짧게 두지 말 것. 서버에 부담을 주고, IP가 막히면 감시 자체가 멈춘다.
- 이 도구는 공개된 상품 페이지만 읽는다. 로그인이 필요한 영역에는 접근하지 않는다.
