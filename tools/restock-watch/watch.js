#!/usr/bin/env node
/**
 * 재입고 감시기 (restock-watch)
 *
 * 쿠팡 상품 페이지를 주기적으로 열어보고 품절 -> 판매중으로 바뀌는 순간
 * 카카오톡(나에게 보내기) / 슬랙 / 디스코드로 알림을 쏜다.
 * 구매 자체를 대신하지는 않는다. 알림에 담긴 링크로 사람이 직접 결제한다.
 *
 * 의존성 없음. node 18+ 면 그냥 돈다.
 *   node watch.js check          1회 검사
 *   node watch.js watch          주기 검사 (상주)
 *   node watch.js resolve <url>  단축링크 -> 실제 상품 URL
 *   node watch.js dump <url>     받아온 HTML 저장 (셀렉터 점검용)
 *   node watch.js notify-test    알림 채널만 점검
 *   node watch.js selftest       파서 회귀 테스트
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const HERE = __dirname;
const DEFAULT_CONFIG = path.join(HERE, 'targets.json');
const DEFAULT_STATE = path.join(HERE, 'state.json');

/* 쿠팡은 데이터센터 IP에서 오는 잦은 요청을 바로 막는다.
   60초보다 짧게는 못 내려가게 막아둔다. */
const MIN_INTERVAL_SECONDS = 60;

/* 판매중/품절 신호 세기 차이가 이보다 작으면 판정을 포기한다 */
const AMBIGUITY_MARGIN = 15;

const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/* ------------------------------------------------------------------ *
 * 재고 판정
 *
 * 쿠팡 마크업은 예고 없이 바뀐다. 그래서 셀렉터 하나에 걸지 않고
 * 여러 신호를 모아 가장 신뢰도 높은 쪽을 택한다. 신호가 서로 부딪히거나
 * 하나도 안 잡히면 unknown 으로 두고 알림을 보내지 않는다.
 * 잘못된 "재입고!" 알림이 놓친 알림보다 더 나쁘기 때문이다.
 * ------------------------------------------------------------------ */
const SIGNALS = [
  // -- 품절 --
  { id: 'ld-oos',      verdict: 'out', weight: 100, re: /"availability"\s*:\s*"[^"]*OutOfStock"/i },
  { id: 'meta-oos',    verdict: 'out', weight: 95,  re: /product:availability"[^>]*content="\s*(?:oos|out\s*of\s*stock)/i },
  { id: 'oos-label',   verdict: 'out', weight: 90,  re: /class="[^"]*oos-label/i },
  { id: 'oos-text',    verdict: 'out', weight: 85,  re: /일시\s*품절/ },
  { id: 'not-sale',    verdict: 'out', weight: 85,  re: /현재\s*판매하지\s*않는\s*상품/ },
  { id: 'sold-out',    verdict: 'out', weight: 75,  re: /품절된\s*상품|판매\s*종료/ },
  { id: 'restock-btn', verdict: 'out', weight: 70,  re: /재입고\s*알림\s*(?:신청|받기)/ },
  // -- 구매 가능 --
  { id: 'ld-in',       verdict: 'in',  weight: 100, re: /"availability"\s*:\s*"[^"]*InStock"/i },
  { id: 'meta-in',     verdict: 'in',  weight: 95,  re: /product:availability"[^>]*content="\s*instock/i },
  { id: 'cart-btn',    verdict: 'in',  weight: 70,  re: /장바구니\s*담기/ },
  { id: 'buy-btn',     verdict: 'in',  weight: 65,  re: /바로\s*구매|구매하기<|지금\s*구매/ },
];

const PRICE_PATTERNS = [
  /"salePrice"\s*:\s*"?([\d,]+)/,
  /itemprop="price"[^>]*content="([\d,.]+)"/,
  /<span class="total-price">\s*<strong>\s*([\d,]+)\s*원/,
  /"price"\s*:\s*"?([\d,]+)"?/,
];

const TITLE_PATTERNS = [
  /<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i,
  /<h1[^>]*class="[^"]*prod-buy-header__title[^"]*"[^>]*>\s*([^<]+)/i,
  /<title>([^<]+)<\/title>/i,
];

function firstMatch(html, patterns) {
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) return m[1].trim();
  }
  return null;
}

/**
 * HTML을 보고 재고 상태를 판정한다.
 * @returns {{status:'in'|'out'|'unknown', matched:string[], reason:string}}
 */
function judgeStock(html) {
  const matched = [];
  let bestIn = 0;
  let bestOut = 0;

  for (const sig of SIGNALS) {
    if (!sig.re.test(html)) continue;
    matched.push(sig.id);
    if (sig.verdict === 'in') bestIn = Math.max(bestIn, sig.weight);
    else bestOut = Math.max(bestOut, sig.weight);
  }

  if (bestIn === 0 && bestOut === 0) {
    return { status: 'unknown', matched, reason: '재고 신호를 하나도 못 찾음 (마크업이 바뀌었거나 차단 페이지)' };
  }
  // 양쪽이 비슷한 세기로 잡히면 어느 쪽도 믿지 않는다. 쿠팡은 품절 상품에도
  // og 메타가 instock 인 채로 남아 있는 경우가 있어서, 근소한 우세로
  // "재입고!" 를 쏘면 헛걸음을 시킨다.
  if (Math.abs(bestIn - bestOut) < AMBIGUITY_MARGIN) {
    return { status: 'unknown', matched, reason: `판매중(${bestIn})/품절(${bestOut}) 신호가 맞붙음` };
  }
  return bestIn > bestOut
    ? { status: 'in', matched, reason: '판매중 신호 우세' }
    : { status: 'out', matched, reason: '품절 신호 우세' };
}

function parsePrice(html) {
  const raw = firstMatch(html, PRICE_PATTERNS);
  if (!raw) return null;
  const n = Number(raw.replace(/[,]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseTitle(html) {
  const t = firstMatch(html, TITLE_PATTERNS);
  return t ? t.replace(/\s+/g, ' ').slice(0, 120) : null;
}

/* ------------------------------------------------------------------ *
 * 페이지 가져오기
 * ------------------------------------------------------------------ */

function browserHeaders(userAgent, referer) {
  return {
    'User-Agent': userAgent,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    ...(referer ? { Referer: referer } : {}),
  };
}

async function fetchHtml(url, opts = {}) {
  const { timeoutMs = 15000, userAgent = DEFAULT_UA, retries = 2 } = opts;
  let lastErr = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: browserHeaders(userAgent, 'https://www.coupang.com/'),
        redirect: 'follow',
        signal: ctrl.signal,
      });
      const body = await res.text();
      return { ok: res.ok, httpStatus: res.status, finalUrl: res.url || url, body };
    } catch (err) {
      lastErr = err;
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, httpStatus: 0, finalUrl: url, body: '', error: String(lastErr && lastErr.message || lastErr) };
}

/**
 * playwright 가 깔려 있으면 진짜 브라우저로 렌더해서 가져온다.
 * 쿠팡이 평범한 fetch 를 막을 때 쓰는 경로. 없으면 조용히 null.
 */
async function fetchHtmlViaBrowser(url, opts = {}) {
  const { timeoutMs = 30000, userAgent = DEFAULT_UA } = opts;
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch {
    return null;
  }
  const launch = {};
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) launch.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  const browser = await chromium.launch(launch);
  try {
    const ctx = await browser.newContext({ userAgent, locale: 'ko-KR' });
    const page = await ctx.newPage();
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    const body = await page.content();
    return { ok: !!res && res.ok(), httpStatus: res ? res.status() : 0, finalUrl: page.url(), body };
  } finally {
    await browser.close();
  }
}

/** 상품 하나를 실제로 확인한다. */
async function probe(target, cfg) {
  const url = target.url || target.shortUrl;
  if (!url) return { status: 'error', reason: 'url 이 비어 있음' };

  const opts = { timeoutMs: cfg.timeoutMs, userAgent: cfg.userAgent, retries: cfg.retries };
  let r = null;

  if (cfg.useBrowser) {
    r = await fetchHtmlViaBrowser(url, opts);
    if (!r) console.warn('  ! playwright 가 없어 일반 요청으로 대체합니다 (npm i playwright)');
  }
  if (!r) r = await fetchHtml(url, opts);

  if (r.httpStatus === 404) return { status: 'gone', httpStatus: 404, reason: '상품 페이지 없음(404)', url };
  if (r.httpStatus === 403 || r.httpStatus === 429) {
    return { status: 'blocked', httpStatus: r.httpStatus, reason: `쿠팡이 요청을 거절함(${r.httpStatus}). 주기를 늘리거나 --browser 로 실행하세요`, url };
  }
  if (!r.ok || !r.body) {
    return { status: 'error', httpStatus: r.httpStatus, reason: r.error || `HTTP ${r.httpStatus}`, url };
  }

  const verdict = judgeStock(r.body);
  return {
    status: verdict.status,
    matched: verdict.matched,
    reason: verdict.reason,
    price: parsePrice(r.body),
    title: parseTitle(r.body),
    httpStatus: r.httpStatus,
    url: r.finalUrl || url,
  };
}

/* ------------------------------------------------------------------ *
 * 알림
 * ------------------------------------------------------------------ */

/** "env:NAME" 이면 환경변수에서 읽는다. 토큰을 설정 파일에 안 적어도 되게. */
function secret(value) {
  if (typeof value !== 'string') return value;
  if (value.startsWith('env:')) return process.env[value.slice(4)] || '';
  return value;
}

async function postForm(url, headers, form) {
  const body = new URLSearchParams(form).toString();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8', ...headers },
    body,
  });
  return { ok: res.ok, status: res.status, text: await res.text().catch(() => '') };
}

async function postJson(url, payload, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
  return { ok: res.ok, status: res.status, text: await res.text().catch(() => '') };
}

/* 카카오 액세스 토큰은 6시간이면 만료된다. 상주로 돌리는 감시기라
   갱신을 못 하면 하룻밤 사이에 알림이 조용히 죽는다. 리프레시 토큰으로 다시 받는다. */
let kakaoTokenCache = null;

async function refreshKakaoToken(conf) {
  const restApiKey = secret(conf.restApiKey);
  const refreshToken = secret(conf.refreshToken);
  if (!restApiKey || !refreshToken) {
    throw new Error('액세스 토큰이 만료됐습니다. restApiKey + refreshToken 을 설정하면 자동으로 갱신합니다');
  }
  const form = { grant_type: 'refresh_token', client_id: restApiKey, refresh_token: refreshToken };
  if (secret(conf.clientSecret)) form.client_secret = secret(conf.clientSecret);

  const r = await postForm('https://kauth.kakao.com/oauth/token', {}, form);
  if (!r.ok) throw new Error(`카카오 토큰 갱신 실패 ${r.status} ${r.text.slice(0, 200)}`);

  const data = JSON.parse(r.text);
  kakaoTokenCache = data.access_token;
  if (data.refresh_token) {
    // 리프레시 토큰도 가끔 새로 내려온다. 놓치면 두 달 뒤에 끊긴다.
    console.warn('  ! 카카오 리프레시 토큰이 갱신됐습니다. 설정에 새 값을 넣어두세요:');
    console.warn(`    ${data.refresh_token}`);
  }
  return kakaoTokenCache;
}

/* 디스코드 임베드. 색으로 무슨 일인지 한눈에 보이게 한다. */
const DISCORD_COLORS = {
  restock:    0x2ecc71, // 초록 - 지금 사야 하는 상황
  available:  0x2ecc71,
  price_drop: 0x3498db, // 파랑 - 값이 내려감
  soldout:    0x95a5a6, // 회색 - 빠졌음
  gone:       0xe74c3c, // 빨강 - 페이지가 없어짐
  test:       0x9b59b6,
};

function buildDiscordEmbed(msg) {
  const embed = {
    title: msg.name,
    url: msg.url,
    description: msg.label ? `**${msg.label}**` : msg.text,
    color: DISCORD_COLORS[msg.event] ?? 0x95a5a6,
    timestamp: new Date().toISOString(),
    fields: [],
  };
  if (msg.price != null) {
    embed.fields.push({ name: '가격', value: `${msg.price.toLocaleString('ko-KR')}원`, inline: true });
  }
  embed.fields.push({ name: '바로가기', value: `[쿠팡에서 열기](${msg.url})`, inline: true });
  return embed;
}

const CHANNELS = {
  /* 카카오톡 "나에게 보내기". talk_message 스코프가 필요하다. 본문 200자 제한. */
  async kakao(conf, msg) {
    const template = {
      object_type: 'text',
      text: msg.text.slice(0, 200),
      link: { web_url: msg.url, mobile_web_url: msg.url },
      button_title: '구매하러 가기',
    };
    const send = (token) => postForm(
      'https://kapi.kakao.com/v2/api/talk/memo/default/send',
      { Authorization: `Bearer ${token}` },
      { template_object: JSON.stringify(template) },
    );

    let token = kakaoTokenCache || secret(conf.accessToken);
    if (!token) token = await refreshKakaoToken(conf);

    let r = await send(token);
    if (r.status === 401) {
      token = await refreshKakaoToken(conf);
      r = await send(token);
    }
    if (!r.ok) throw new Error(`kakao ${r.status} ${r.text.slice(0, 200)}`);
  },

  async slack(conf, msg) {
    const hook = secret(conf.webhookUrl);
    if (!hook) throw new Error('slack webhookUrl 이 비어 있음');
    const r = await postJson(hook, { text: `${msg.text}\n${msg.url}` });
    if (!r.ok) throw new Error(`slack ${r.status} ${r.text.slice(0, 200)}`);
  },

  async discord(conf, msg) {
    const hook = secret(conf.webhookUrl);
    if (!hook) throw new Error('discord webhookUrl 이 비어 있음');

    const payload = {
      username: conf.username || '재입고 감시기',
      embeds: [buildDiscordEmbed(msg)],
      // 상품명에 @everyone 같은 문자열이 섞여 들어와도 멘션으로 터지지 않게 막는다.
      // mention 을 설정한 경우에만 실제 멘션을 허용한다.
      allowed_mentions: { parse: [] },
    };
    /* 재입고는 놓치면 끝이라 알림음이 울리게 멘션을 붙일 수 있다. 예: "@here", "<@사용자ID>"
       단 지금 당장 살 수 있는 알림에만 붙인다. 품절 전환까지 @here 가 울리면
       며칠 만에 알림을 꺼버리게 된다. */
    const MENTION_DEFAULT = ['restock', 'available', 'price_drop', 'test'];
    const mentionOn = conf.mentionOn || MENTION_DEFAULT;
    if (conf.mention && mentionOn.includes(msg.event)) {
      payload.content = conf.mention;
      payload.allowed_mentions = { parse: ['everyone', 'users', 'roles'] };
    }

    let r = await postJson(hook, payload);
    if (r.status === 429) {
      // 디스코드 웹훅 레이트리밋. 얼마나 기다리라고 알려주니 그만큼 쉬고 한 번만 재시도.
      let waitMs = 1000;
      try { waitMs = Math.ceil((JSON.parse(r.text).retry_after || 1) * 1000); } catch { /* 기본값 */ }
      await sleep(Math.min(waitMs, 10000));
      r = await postJson(hook, payload);
    }
    if (!r.ok) throw new Error(`discord ${r.status} ${r.text.slice(0, 200)}`);
  },

  /* 아무 서비스나 붙일 수 있는 범용 훅 (ntfy, IFTTT, 사내 API 등) */
  async webhook(conf, msg) {
    const url = secret(conf.url);
    if (!url) throw new Error('webhook url 이 비어 있음');
    const r = await postJson(url, msg, conf.headers || {});
    if (!r.ok) throw new Error(`webhook ${r.status} ${r.text.slice(0, 200)}`);
  },

  /* 로컬 명령 실행. 맥 알림음, ntfy CLI 같은 걸 붙일 때. */
  async exec(conf, msg) {
    if (!conf.command) throw new Error('exec command 가 비어 있음');
    await new Promise((resolve, reject) => {
      const child = spawn(conf.command, {
        shell: true,
        stdio: 'inherit',
        env: {
          ...process.env,
          RESTOCK_EVENT: msg.event,
          RESTOCK_NAME: msg.name,
          RESTOCK_TEXT: msg.text,
          RESTOCK_URL: msg.url,
          RESTOCK_PRICE: msg.price == null ? '' : String(msg.price),
        },
      });
      child.on('error', reject);
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`exec 종료 코드 ${code}`))));
    });
  },
};

async function notify(cfg, msg) {
  console.log(`  >> ${msg.text}`);
  console.log(`     ${msg.url}`);

  const entries = Object.entries(cfg.notify || {}).filter(([, c]) => c && c.enabled);
  if (entries.length === 0) {
    console.warn('  ! 켜진 알림 채널이 없습니다. targets.json 의 notify 를 설정하세요.');
    return;
  }
  for (const [name, conf] of entries) {
    const send = CHANNELS[name];
    if (!send) {
      console.warn(`  ! 모르는 채널: ${name}`);
      continue;
    }
    try {
      await send(conf, msg);
      console.log(`     [${name}] 전송 완료`);
    } catch (err) {
      console.error(`     [${name}] 전송 실패: ${err.message}`);
    }
  }
}

/* ------------------------------------------------------------------ *
 * 상태 / 설정
 * ------------------------------------------------------------------ */

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw new Error(`${file} 읽기 실패: ${err.message}`);
  }
}

function writeJson(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, file); // 중간에 죽어도 state.json 이 깨지지 않게
}

function loadConfig(file) {
  const raw = readJson(file);
  const cfg = {
    intervalSeconds: Math.max(MIN_INTERVAL_SECONDS, raw.intervalSeconds || 300),
    jitterSeconds: raw.jitterSeconds ?? 60,
    timeoutMs: raw.timeoutMs || 15000,
    retries: raw.retries ?? 2,
    userAgent: raw.userAgent || DEFAULT_UA,
    notify: raw.notify || {},
    targets: raw.targets || [],
    useBrowser: false,
  };
  if (cfg.targets.length === 0) throw new Error(`${file} 에 targets 가 비어 있습니다`);
  cfg.targets.forEach((t, i) => {
    if (!t.id) t.id = `target-${i + 1}`;
    if (!t.name) t.name = t.id;
    if (!t.notifyOn) t.notifyOn = ['restock', 'available'];
    if (t.cooldownMinutes == null) t.cooldownMinutes = 120;
  });
  if (raw.intervalSeconds && raw.intervalSeconds < MIN_INTERVAL_SECONDS) {
    console.warn(`! intervalSeconds 를 ${MIN_INTERVAL_SECONDS}초로 올렸습니다. 더 짧으면 쿠팡이 IP를 막습니다.`);
  }
  return cfg;
}

/* ------------------------------------------------------------------ *
 * 이벤트 판정
 *
 * 상태가 "바뀌는 순간"에만 알린다. 품절인 채로 계속 있으면 조용하다.
 * ------------------------------------------------------------------ */
function decideEvents(target, prev, now) {
  const wanted = (e) => target.notifyOn.includes(e.kind);
  const stock = [];
  const wasStocked = prev && prev.status === 'in';
  const firstLook = !prev || !prev.status;

  if (now.status === 'in') {
    if (firstLook) stock.push({ kind: 'available', label: '지금 구매 가능' });
    else if (!wasStocked) stock.push({ kind: 'restock', label: '재입고' });
  } else if (now.status === 'out' && wasStocked) {
    stock.push({ kind: 'soldout', label: '품절 전환' });
  } else if (now.status === 'gone' && (!prev || prev.status !== 'gone')) {
    // 계속 404 인 상품을 쿨다운마다 다시 알리지 않는다. 사라진 순간 한 번만.
    stock.push({ kind: 'gone', label: '상품 페이지가 사라짐' });
  }

  const events = stock.filter(wanted);

  // 가격 조건: 목표가 위에 있다가 아래로 내려왔을 때.
  // 실제로 보낼 재고 알림이 이미 있으면 건너뛴다. 알림 문구에 가격이 이미
  // 들어가는데 같은 사건으로 두 통을 보낼 이유가 없다. 반대로 재고 알림을
  // 껐다면(notifyOn 에 price_drop 만) 가격 알림은 살아 있어야 한다.
  if (events.length === 0 && now.status === 'in' && target.maxPrice && now.price != null
      && now.price <= target.maxPrice && prev && prev.price != null && prev.price > target.maxPrice) {
    const drop = { kind: 'price_drop', label: `목표가 이하 (${target.maxPrice.toLocaleString('ko-KR')}원)` };
    if (wanted(drop)) events.push(drop);
  }

  return events;
}

function withinCooldown(prev, kind, cooldownMinutes) {
  if (!prev || !prev.notifiedAt || !prev.notifiedAt[kind]) return false;
  const elapsed = Date.now() - new Date(prev.notifiedAt[kind]).getTime();
  return elapsed < cooldownMinutes * 60 * 1000;
}

const STATUS_LABEL = {
  in: '판매중',
  out: '품절',
  unknown: '판정불가',
  blocked: '차단됨',
  error: '오류',
  gone: '없어짐',
};

/* ------------------------------------------------------------------ *
 * 한 바퀴 돌기
 * ------------------------------------------------------------------ */
async function runOnce(cfg, statePath) {
  const state = readJson(statePath, { targets: {} });
  if (!state.targets) state.targets = {};
  const stamp = new Date().toISOString();

  for (const target of cfg.targets) {
    const prev = state.targets[target.id] || null;
    const now = await probe(target, cfg);

    const priceText = now.price != null ? ` ${now.price.toLocaleString('ko-KR')}원` : '';
    console.log(`[${stamp}] ${target.name}: ${STATUS_LABEL[now.status] || now.status}${priceText}`);
    if (now.status !== 'in' && now.status !== 'out') console.log(`  - ${now.reason}`);

    // 판정 못 한 회차는 상태를 덮어쓰지 않는다. 차단/오류를 "품절"로 기록하면
    // 다음에 정상 응답이 왔을 때 가짜 재입고 알림이 나간다.
    if (now.status === 'unknown' || now.status === 'blocked' || now.status === 'error') {
      const misses = (prev && prev.consecutiveMisses ? prev.consecutiveMisses : 0) + 1;
      state.targets[target.id] = { ...(prev || {}), consecutiveMisses: misses, lastCheckedAt: stamp, lastMissReason: now.reason };
      if (misses === 5 || misses % 20 === 0) {
        console.warn(`  ! ${misses}회 연속 판정 실패. 'node watch.js dump <url>' 로 HTML을 받아 SIGNALS 를 손보세요.`);
      }
      continue;
    }

    const events = decideEvents(target, prev, now);
    const notifiedAt = { ...((prev && prev.notifiedAt) || {}) };

    for (const ev of events) {
      if (withinCooldown(prev, ev.kind, target.cooldownMinutes)) {
        console.log(`  - ${ev.label} 이지만 쿨다운(${target.cooldownMinutes}분) 중이라 건너뜀`);
        continue;
      }
      await notify(cfg, {
        event: ev.kind,
        label: ev.label,
        name: target.name,
        price: now.price,
        url: target.shortUrl || now.url,
        text: `[${ev.label}] ${target.name}${priceText}`,
      });
      notifiedAt[ev.kind] = stamp;
    }

    state.targets[target.id] = {
      status: now.status,
      price: now.price,
      title: now.title || (prev && prev.title) || null,
      matched: now.matched,
      lastCheckedAt: stamp,
      changedAt: prev && prev.status === now.status ? prev.changedAt : stamp,
      consecutiveMisses: 0,
      notifiedAt,
    };
  }

  writeJson(statePath, state);
}

async function runForever(cfg, statePath) {
  console.log(`감시 시작: ${cfg.targets.length}개 상품, ${cfg.intervalSeconds}초 주기 (±${cfg.jitterSeconds}초)`);
  console.log('중지: Ctrl+C\n');
  for (;;) {
    try {
      await runOnce(cfg, statePath);
    } catch (err) {
      console.error(`검사 중 오류: ${err.message}`);
    }
    // 정확히 같은 간격으로 때리면 패턴이 보인다. 흔들어 준다.
    const jitter = Math.floor((Math.random() * 2 - 1) * cfg.jitterSeconds);
    const wait = Math.max(MIN_INTERVAL_SECONDS, cfg.intervalSeconds + jitter);
    await sleep(wait * 1000);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * 서브커맨드
 * ------------------------------------------------------------------ */

async function cmdResolve(url, cfg) {
  if (!url) throw new Error('사용법: node watch.js resolve <단축링크>');
  const r = await fetchHtml(url, { timeoutMs: cfg.timeoutMs, userAgent: cfg.userAgent, retries: 1 });
  const finalUrl = r.finalUrl;
  console.log(`HTTP ${r.httpStatus}`);
  console.log(`최종 URL: ${finalUrl}`);

  const productId = (finalUrl.match(/\/vp\/products\/(\d+)/) || [])[1];
  const q = finalUrl.includes('?') ? new URLSearchParams(finalUrl.split('?')[1]) : new URLSearchParams();
  if (productId) {
    console.log(`\nproductId     : ${productId}`);
    console.log(`itemId        : ${q.get('itemId') || '-'}`);
    console.log(`vendorItemId  : ${q.get('vendorItemId') || '-'}`);
    const clean = `https://www.coupang.com/vp/products/${productId}` +
      (q.get('itemId') ? `?itemId=${q.get('itemId')}&vendorItemId=${q.get('vendorItemId') || ''}` : '');
    console.log(`\ntargets.json 의 url 에 넣을 값:\n  ${clean}`);
  } else {
    console.log('\n상품 ID를 못 찾았습니다. 브라우저에서 링크를 연 뒤 주소창의 URL을 그대로 쓰세요.');
  }
  if (r.body) console.log(`\n재고 판정: ${STATUS_LABEL[judgeStock(r.body).status]}`);
}

async function cmdDump(url, outPath, cfg) {
  if (!url) throw new Error('사용법: node watch.js dump <url> [-o 파일]');
  let r = cfg.useBrowser ? await fetchHtmlViaBrowser(url, cfg) : null;
  if (!r) r = await fetchHtml(url, { timeoutMs: cfg.timeoutMs, userAgent: cfg.userAgent, retries: 1 });
  const out = outPath || path.join(HERE, 'dump.html');
  fs.writeFileSync(out, r.body || '');
  const v = judgeStock(r.body || '');
  console.log(`HTTP ${r.httpStatus} -> ${out} (${(r.body || '').length.toLocaleString('ko-KR')} bytes)`);
  console.log(`판정: ${STATUS_LABEL[v.status]} / 걸린 신호: ${v.matched.join(', ') || '없음'}`);
  console.log(`가격: ${parsePrice(r.body || '') ?? '못 찾음'}`);
  console.log(`제목: ${parseTitle(r.body || '') ?? '못 찾음'}`);
}

async function cmdNotifyTest(cfg) {
  const t = cfg.targets[0];
  await notify(cfg, {
    event: 'test',
    label: '테스트',
    name: t.name,
    price: t.maxPrice ?? null,
    url: t.shortUrl || t.url,
    text: `[테스트] ${t.name} 알림 채널 점검`,
  });
}

/* 회귀 테스트 본체는 test.js 하나로 유지한다.
   require 로 부르면 순환 참조가 되니 별도 프로세스로 돌린다. */
function cmdSelftest() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(HERE, 'test.js')], { stdio: 'inherit' });
    child.on('exit', (code) => {
      process.exitCode = code === 0 ? 0 : 1;
      resolve();
    });
  });
}

function usage() {
  console.log(`재입고 감시기 (restock-watch)

  node watch.js check                 1회 검사하고 종료 (cron 용)
  node watch.js watch                 주기적으로 계속 검사
  node watch.js resolve <단축링크>     link.coupang.com 링크에서 상품 URL 추출
  node watch.js dump <url> [-o 파일]   받아온 HTML 저장 + 판정 결과 출력
  node watch.js notify-test           알림 채널만 시험 발송
  node watch.js selftest              파서 회귀 테스트

옵션
  --config <경로>   설정 파일 (기본: ./targets.json)
  --state  <경로>   상태 파일 (기본: ./state.json)
  --browser         playwright 로 실제 브라우저를 띄워서 가져오기
`);
}

async function main(argv) {
  const args = argv.slice(2);
  const cmd = args[0] || 'help';

  // --config/--state/-o 는 값을 하나 먹고, 나머지 비플래그 인자는 위치 인자다
  const VALUE_FLAGS = new Set(['--config', '--state', '-o']);
  const opts = {};
  const positional = [];
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (VALUE_FLAGS.has(a)) opts[a] = args[++i];
    else if (a.startsWith('-')) opts[a] = true;
    else positional.push(a);
  }
  const configPath = opts['--config'] || DEFAULT_CONFIG;
  const statePath = opts['--state'] || DEFAULT_STATE;
  const useBrowser = opts['--browser'] === true;

  if (cmd === 'selftest') return await cmdSelftest();
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') return usage();

  // resolve / dump 는 설정 파일 없이도 돌아야 한다
  const needsConfig = cmd === 'check' || cmd === 'watch' || cmd === 'notify-test';
  let cfg;
  if (needsConfig) {
    cfg = loadConfig(configPath);
  } else {
    cfg = { timeoutMs: 15000, retries: 2, userAgent: DEFAULT_UA, notify: {}, targets: [] };
  }
  cfg.useBrowser = useBrowser;

  switch (cmd) {
    case 'check': return runOnce(cfg, statePath);
    case 'watch': return runForever(cfg, statePath);
    case 'resolve': return cmdResolve(positional[0], cfg);
    case 'dump': return cmdDump(positional[0], opts['-o'] || null, cfg);
    case 'notify-test': return cmdNotifyTest(cfg);
    default:
      usage();
      throw new Error(`모르는 명령: ${cmd}`);
  }
}

if (require.main === module) {
  main(process.argv).catch((err) => {
    console.error(`\n오류: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { judgeStock, parsePrice, parseTitle, decideEvents, CHANNELS };
