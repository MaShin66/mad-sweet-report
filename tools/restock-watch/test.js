#!/usr/bin/env node
/**
 * 회귀 테스트. 의존성 없음.
 *   node test.js
 *
 * watch.js 의 SIGNALS 를 손볼 때 여기부터 통과시키면 된다.
 */
'use strict';

const { judgeStock, parsePrice, decideEvents, CHANNELS } = require('./watch.js');

let failed = 0;
function check(name, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  (${detail})`}`);
}

/* ---- 재고 판정 ---- */
const STOCK_CASES = [
  ['판매중: JSON-LD', '{"availability":"http://schema.org/InStock"}', 'in'],
  ['판매중: 장바구니 버튼', '<button class="prod-cart-btn">장바구니 담기</button>', 'in'],
  ['판매중: og 메타', '<meta property="product:availability" content="instock">', 'in'],
  ['품절: JSON-LD', '{"availability":"http://schema.org/OutOfStock"}', 'out'],
  ['품절: 일시품절 라벨', '<div class="oos-label">일시품절</div>', 'out'],
  ['품절: 재입고 알림 버튼', '<button>재입고 알림 신청</button>', 'out'],
  ['품절: 판매 종료', '<p>현재 판매하지 않는 상품입니다</p>', 'out'],
  ['판정불가: 빈 문서', '<html></html>', 'unknown'],
  ['판정불가: 봇 확인 페이지', '<html><body>Access Denied</body></html>', 'unknown'],
  ['판정불가: 신호 충돌', '<meta property="product:availability" content="instock"><div class="oos-label">일시품절</div>', 'unknown'],
  // JSON-LD(가중치 100)는 버튼 텍스트(70)보다 세다. 품절인데 버튼이 남아 있는
  // 페이지에서 가짜 재입고가 나가면 안 된다.
  ['품절 우선: LD 품절 + 장바구니 버튼',
    '{"availability":"http://schema.org/OutOfStock"}<button>장바구니 담기</button>', 'out'],
];
for (const [name, html, expect] of STOCK_CASES) {
  const got = judgeStock(html).status;
  check(name, got === expect, `기대=${expect} 실제=${got}`);
}

/* ---- 가격 파싱 ---- */
check('가격: total-price', parsePrice('<span class="total-price"><strong>8,900 원</strong>') === 8900);
check('가격: salePrice', parsePrice('{"salePrice":12900}') === 12900);
check('가격: itemprop', parsePrice('<meta itemprop="price" content="7,500">') === 7500);
check('가격: 없으면 null', parsePrice('<html></html>') === null);

/* ---- 이벤트 전환 ---- */
const target = { notifyOn: ['restock', 'available', 'price_drop', 'soldout'], maxPrice: 9000 };
const kinds = (prev, now) => decideEvents(target, prev, now).map((e) => e.kind);

check('첫 관측 + 판매중 -> available', String(kinds(null, { status: 'in', price: 8900 })) === 'available');
check('첫 관측 + 품절 -> 조용', kinds(null, { status: 'out', price: 8900 }).length === 0);
check('품절 -> 판매중 = 재입고', kinds({ status: 'out', price: 8900 }, { status: 'in', price: 8900 })[0] === 'restock');
check('판매중 -> 판매중 = 조용', kinds({ status: 'in', price: 8900 }, { status: 'in', price: 8900 }).length === 0);
check('판매중 -> 품절 = soldout', kinds({ status: 'in', price: 8900 }, { status: 'out', price: 8900 })[0] === 'soldout');
check('품절 -> 품절 = 조용', kinds({ status: 'out', price: 8900 }, { status: 'out', price: 8900 }).length === 0);
check('목표가 위 -> 아래 = price_drop',
  kinds({ status: 'in', price: 11000 }, { status: 'in', price: 8500 })[0] === 'price_drop');
check('목표가 아래 유지 = 조용',
  kinds({ status: 'in', price: 8500 }, { status: 'in', price: 8600 }).length === 0);
check('404 = gone', decideEvents({ notifyOn: ['gone'] }, { status: 'in' }, { status: 'gone' })[0].kind === 'gone');
check('notifyOn 에 없으면 안 보냄',
  decideEvents({ notifyOn: ['restock'] }, { status: 'in' }, { status: 'out' }).length === 0);
// 재고 알림을 끄고 가격 알림만 켠 경우, 재입고 회차의 가격 알림이 삼켜지면 안 된다
check('price_drop 만 켰을 때 재입고 회차에도 살아남음',
  decideEvents({ notifyOn: ['price_drop'], maxPrice: 9000 },
    { status: 'out', price: 11000 }, { status: 'in', price: 8500 })[0].kind === 'price_drop');
check('재고 알림이 살아 있으면 가격 알림은 접힘',
  decideEvents({ notifyOn: ['restock', 'price_drop'], maxPrice: 9000 },
    { status: 'out', price: 11000 }, { status: 'in', price: 8500 }).length === 1);

/* ---- 디스코드 임베드 ---- */
async function discordTests() {
  const realFetch = global.fetch;
  const capture = (responses) => {
    const sent = [];
    let n = 0;
    global.fetch = async (url, init) => {
      sent.push({ url, body: JSON.parse(init.body) });
      const r = responses[Math.min(n++, responses.length - 1)];
      return { ok: r.status < 300, status: r.status, text: async () => r.text || '{}' };
    };
    return sent;
  };

  try {
    // 재입고 알림 한 통
    let sent = capture([{ status: 204 }]);
    await CHANNELS.discord(
      { webhookUrl: 'https://discord.test/hook' },
      { event: 'restock', label: '재입고', name: '서울우유 생크림', price: 8900, url: 'https://link.test/a', text: '[재입고] 서울우유 생크림 8,900원' },
    );
    const body = sent[0].body;
    const embed = body.embeds[0];
    check('디스코드: 임베드 1개', body.embeds.length === 1);
    check('디스코드: 상품명이 제목', embed.title === '서울우유 생크림');
    check('디스코드: 제목에 링크', embed.url === 'https://link.test/a');
    check('디스코드: 재입고는 초록', embed.color === 0x2ecc71, String(embed.color));
    check('디스코드: 가격 필드', embed.fields.some((f) => f.value === '8,900원'));
    check('디스코드: 타임스탬프 ISO', !Number.isNaN(Date.parse(embed.timestamp)));
    check('디스코드: 멘션 없으면 전부 차단', JSON.stringify(body.allowed_mentions) === '{"parse":[]}');
    check('디스코드: content 비어 있음', body.content === undefined);

    // 이벤트별 색이 갈리는지
    sent = capture([{ status: 204 }]);
    await CHANNELS.discord({ webhookUrl: 'https://discord.test/hook' },
      { event: 'soldout', label: '품절 전환', name: 'x', price: null, url: 'https://t', text: 't' });
    check('디스코드: 품절은 회색', sent[0].body.embeds[0].color === 0x95a5a6);
    check('디스코드: 가격 없으면 필드 생략', !sent[0].body.embeds[0].fields.some((f) => f.name === '가격'));

    // 멘션을 켜면 content 에 실리고 멘션이 허용돼야 한다
    sent = capture([{ status: 204 }]);
    await CHANNELS.discord({ webhookUrl: 'https://discord.test/hook', mention: '@here', username: '생크림봇' },
      { event: 'restock', label: '재입고', name: 'x', price: 1000, url: 'https://t', text: 't' });
    check('디스코드: 멘션이 content 로', sent[0].body.content === '@here');
    check('디스코드: 멘션 허용됨', sent[0].body.allowed_mentions.parse.includes('everyone'));
    check('디스코드: username 반영', sent[0].body.username === '생크림봇');

    // 살 수 없는 알림(품절 전환)에는 멘션이 붙으면 안 된다
    sent = capture([{ status: 204 }]);
    await CHANNELS.discord({ webhookUrl: 'https://discord.test/hook', mention: '@here' },
      { event: 'soldout', label: '품절 전환', name: 'x', price: null, url: 'https://t', text: 't' });
    check('디스코드: 품절 전환엔 멘션 안 붙음', sent[0].body.content === undefined);
    check('디스코드: 멘션 없을 때 파싱 차단', JSON.stringify(sent[0].body.allowed_mentions) === '{\"parse\":[]}');

    // mentionOn 을 직접 지정하면 그대로 따른다
    sent = capture([{ status: 204 }]);
    await CHANNELS.discord({ webhookUrl: 'https://discord.test/hook', mention: '@here', mentionOn: ['soldout'] },
      { event: 'soldout', label: '품절 전환', name: 'x', price: null, url: 'https://t', text: 't' });
    check('디스코드: mentionOn 직접 지정', sent[0].body.content === '@here');

    // 레이트리밋(429) 을 만나면 retry_after 만큼 쉬고 한 번 재시도
    sent = capture([{ status: 429, text: '{"retry_after":0.05}' }, { status: 204 }]);
    await CHANNELS.discord({ webhookUrl: 'https://discord.test/hook' },
      { event: 'restock', label: '재입고', name: 'x', price: null, url: 'https://t', text: 't' });
    check('디스코드: 429 후 재시도', sent.length === 2, `${sent.length}회 전송`);

    // 두 번째도 실패하면 조용히 넘어가지 말고 던져야 한다
    sent = capture([{ status: 500, text: 'boom' }]);
    let threw = false;
    try {
      await CHANNELS.discord({ webhookUrl: 'https://discord.test/hook' },
        { event: 'restock', label: '재입고', name: 'x', price: null, url: 'https://t', text: 't' });
    } catch { threw = true; }
    check('디스코드: 실패는 예외로', threw);

    // 웹훅 URL 이 없으면 바로 알려줘야 한다
    threw = false;
    try {
      await CHANNELS.discord({ webhookUrl: '' }, { event: 'restock', name: 'x', url: 'https://t', text: 't' });
    } catch { threw = true; }
    check('디스코드: URL 없으면 예외', threw);
  } finally {
    global.fetch = realFetch;
  }
}

/* ---- 카카오 토큰 만료 -> 자동 갱신 ---- */
(async () => {
  await discordTests();

  const seen = [];
  const realFetch = global.fetch;
  global.fetch = async (url, init) => {
    seen.push({ url, auth: (init.headers || {}).Authorization });
    if (url.includes('oauth/token')) {
      return { ok: true, status: 200, text: async () => '{"access_token":"FRESH"}' };
    }
    if (init.headers.Authorization === 'Bearer STALE') {
      return { ok: false, status: 401, text: async () => '{"code":-401}' };
    }
    return { ok: true, status: 200, text: async () => '{"result_code":0}' };
  };
  try {
    await CHANNELS.kakao(
      { accessToken: 'STALE', restApiKey: 'K', refreshToken: 'R' },
      { text: '재입고', url: 'https://example.test' },
    );
    const seq = seen.map((s) => (s.url.includes('oauth/token') ? 'refresh' : 'send')).join('>');
    check('카카오 401 -> 갱신 -> 재전송', seq === 'send>refresh>send', seq);
    check('갱신된 토큰으로 재전송', seen[seen.length - 1].auth === 'Bearer FRESH');
  } catch (err) {
    check('카카오 갱신 경로', false, err.message);
  } finally {
    global.fetch = realFetch;
  }

  console.log(failed === 0 ? '\n전부 통과' : `\n${failed}건 실패`);
  process.exit(failed === 0 ? 0 : 1);
})();
