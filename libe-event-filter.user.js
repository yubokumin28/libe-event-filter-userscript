// ==UserScript==
// @name         リベ イベント フィルター
// @namespace    https://github.com/yubokumin28/libe-event-filter-userscript
// @version      0.5.0
// @description  リベシティのイベントカレンダーを、自分の地域・興味の言葉・カテゴリーで絞り込みます。選んだ予定はGoogleカレンダーの作成画面(下書き)で開けます。
// @author       遊牧民
// @match        https://libecity.com/*
// @icon         https://raw.githubusercontent.com/yubokumin28/libe-event-filter-userscript/main/icon128.png
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @grant        GM_openInTab
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// @homepageURL  https://yubokumin28.github.io/libe-event-filter-userscript/
// @updateURL    https://raw.githubusercontent.com/yubokumin28/libe-event-filter-userscript/main/libe-event-filter.user.js
// @downloadURL  https://raw.githubusercontent.com/yubokumin28/libe-event-filter-userscript/main/libe-event-filter.user.js
// ==/UserScript==
// ⛔ このファイルは 2026-10-30/tools/build_userscript.py が作る。直接直さない(正本は extension/ の中)
(function () {
'use strict';
// ---------- shim.js ----------
// Tampermonkey 版の土台: 拡張の部品(content / background / settings / sidepanel)がそのまま動くよう、
// chrome.* を GM_* とページ内の関数呼び出しで代わりに用意する。保存キー名は拡張と同じ(settings / store / status / profileImage)。
// (部品を2つに分けて持たないための仕掛け。正本は extension\ の中)
const __HOME = 'https://yubokumin28.github.io/libe-event-filter-userscript/';
const __Q = new URLSearchParams(location.search);
const __IS_TOP = window.top === window;
// 裏読み: 一覧を読み直す時に、リベシティのカレンダーを見えない枠(iframe)か裏のタブで開き、lef=<月数> を付ける
const __READER = !!__Q.get('lef');
const __READER_ID = __Q.get('lefw') || '';
// 試験台だけが使う: 開くリベシティの住所を差し替える(本物のリベシティでは undefined のまま)
const __TEST_ORIGIN = typeof window.__LEF_TEST_ORIGIN === 'string' ? window.__LEF_TEST_ORIGIN : null;

// ---------- 保存(chrome.storage → GM_getValue / GM_setValue) ----------
const __AREA = { settings: 'sync', store: 'local', status: 'local', profileImage: 'local', token: 'local', calendarId: 'local' };
const __changeFns = [];
const __clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
function __notify(changes, area) {
  for (const fn of __changeFns) { try { fn(changes, area); } catch (e) { console.error('[リベ イベント フィルター]', e); } }
}
function __area(area) {
  const keysOf = (k) => (k == null ? Object.keys(__AREA).filter((x) => __AREA[x] === area) : typeof k === 'string' ? [k] : Array.isArray(k) ? k : Object.keys(k));
  return {
    get(k, cb) {
      const out = {};
      for (const key of keysOf(k)) { const v = GM_getValue(key); if (v !== undefined) out[key] = v; }
      if (cb) { setTimeout(() => cb(out), 0); return undefined; }
      return Promise.resolve(out);
    },
    set(obj, cb) {
      const changes = {};
      for (const key of Object.keys(obj)) {
        const oldValue = GM_getValue(key);
        const newValue = __clone(obj[key]);
        GM_setValue(key, newValue);
        changes[key] = { oldValue, newValue };
      }
      // chrome.storage.onChanged は書いた本人にも届くので、同じタブの中の画面にも知らせる
      setTimeout(() => __notify(changes, area), 0);
      if (cb) setTimeout(cb, 0);
      return Promise.resolve();
    },
    remove(k, cb) {
      const changes = {};
      for (const key of keysOf(k)) { changes[key] = { oldValue: GM_getValue(key) }; GM_deleteValue(key); }
      setTimeout(() => __notify(changes, area), 0);
      if (cb) setTimeout(cb, 0);
      return Promise.resolve();
    },
  };
}
// 別のタブで変わった時(remote)だけここで知らせる。自分のタブの変化は set() が知らせる
if (__IS_TOP && !__READER) {
  for (const key of Object.keys(__AREA)) {
    GM_addValueChangeListener(key, (name, oldValue, newValue, remote) => {
      if (remote) __notify({ [name]: { oldValue, newValue } }, __AREA[name]);
    });
  }
}

// ---------- 部品どうしの連絡(chrome.runtime.sendMessage → ページ内の関数呼び出し) ----------
// content(読み取り)→ background(保存)、panel(一覧)→ background、background → panel(状態の表示)
const __bus = { content: [], background: [], panel: [] };
function __dispatch(from, msg) {
  const targets = from === 'background' ? ['panel'] : ['background'];
  return new Promise((resolve) => setTimeout(() => {
    let answered = false;
    let pending = false;
    const reply = (v) => { if (!answered) { answered = true; resolve(v); } };
    for (const role of targets) {
      for (const fn of __bus[role]) {
        try { if (fn(msg, { id: 'userscript' }, reply) === true) pending = true; } catch (e) { console.error('[リベ イベント フィルター]', e); }
      }
    }
    if (!pending && !answered) resolve(undefined);
  }, 0));
}
// 裏読みの画面から、頼んだ元のタブへ届ける(見えない枠なら postMessage、裏のタブなら GM の受け渡し口)
function __forward(msg) {
  const packet = { __lefMsg: msg, w: __READER_ID };
  if (!__IS_TOP) {
    try { window.top.postMessage(packet, location.origin); } catch (e) { /* 届かなければ元のタブが時間切れで片付ける */ }
  } else {
    GM_setValue('lefPipe', { ...packet, n: Math.random() });
  }
  return Promise.resolve(undefined);
}
function __send(from, msg) {
  if (from === 'content' && __READER) return __forward(msg);
  return __dispatch(from, msg);
}

// ---------- 裏読み(chrome.windows.create の代わり) ----------
// 1) まず見えない枠(iframe)で開く。リベシティが枠の中で開けない時(中身が読めない時)は、2) 裏のタブで開いて読んだら閉じる
const __readers = new Map(); // w → { frames:[], tabs:[] }
let __readerSeq = 0;
function __openReaders(urls) {
  const w = Date.now().toString(36) + (++__readerSeq);
  const r = { frames: [], tabs: [] };
  __readers.set(w, r);
  for (let url of urls) {
    url += (url.includes('?') ? '&' : '?') + 'lefw=' + w;
    if (__TEST_ORIGIN) url = url.replace('https://libecity.com', __TEST_ORIGIN);
    const f = document.createElement('iframe');
    f.setAttribute('aria-hidden', 'true');
    f.tabIndex = -1;
    // 画面の外に出したり visibility:hidden にすると、リベシティの描画や文字の読み取りが止まるので、見えない(透明)だけにする
    f.style.cssText = 'position:fixed;left:0;top:0;width:1280px;height:900px;opacity:0;pointer-events:none;z-index:-1;border:0;';
    f.addEventListener('load', () => {
      let readable = false;
      try { readable = !!(f.contentDocument && f.contentDocument.body && f.contentWindow.location.href !== 'about:blank'); } catch (e) { readable = false; }
      if (readable || !__readers.has(w) || f.dataset.fallback) return;
      f.dataset.fallback = '1';
      f.remove();
      const tab = GM_openInTab(url, { active: false, insert: true, setParent: true });
      r.tabs.push(tab);
    });
    f.src = url;
    document.documentElement.appendChild(f);
    r.frames.push(f);
  }
  return w;
}
function __closeReaders(w) {
  const r = __readers.get(w);
  if (!r) return;
  __readers.delete(w);
  r.frames.forEach((f) => f.remove());
  r.tabs.forEach((t) => { try { t && t.close && t.close(); } catch (e) { /* 閉じられなくても害は無い */ } });
}
if (__IS_TOP && !__READER) {
  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin || !e.data || !e.data.__lefMsg || !__readers.has(e.data.w)) return;
    __dispatch('content', e.data.__lefMsg);
  });
  GM_addValueChangeListener('lefPipe', (_name, _old, v, remote) => {
    if (remote && v && v.__lefMsg && __readers.has(v.w)) __dispatch('content', v.__lefMsg);
  });
}

// ---------- 開閉ボタンの数字(chrome.action.setBadgeText の代わり) ----------
let __badgeFn = () => {};

// ---------- Googleカレンダー(OAuth)は Tampermonkey 版では使わない。下書きURL(drafts.js)で開く ----------
const __mod_gcal = (() => {
  const off = async () => { throw new Error('Tampermonkey 版では、Googleカレンダーへは作成画面(下書き)で入れます'); };
  return { getToken: off, ensureCalendar: off, syncSelected: off, clearToken: async () => {} };
})();

// 部品ごとの chrome。from は連絡の差出人(content / background / panel / lib)
function __chromeFor(from) {
  return {
    storage: { sync: __area('sync'), local: __area('local'), onChanged: { addListener: (fn) => __changeFns.push(fn) } },
    runtime: {
      sendMessage: (msg) => __send(from, msg),
      onMessage: { addListener: (fn) => { if (__bus[from]) __bus[from].push(fn); } },
      onInstalled: { addListener: (fn) => { if (GM_getValue('status') === undefined) setTimeout(fn, 0); } },
    },
    identity: { getRedirectURL: () => '' },
    sidePanel: { setPanelBehavior: () => Promise.resolve() },
    action: { setBadgeText: ({ text }) => __badgeFn(text), setBadgeBackgroundColor: () => {} },
    tabs: {
      // リベシティの中の移動はこのタブで、Googleカレンダーなどは新しいタブで開く
      create: ({ url, active }) => {
        if (/^https:\/\/libecity\.com\//.test(url)) location.assign(url);
        else GM_openInTab(url, { active: active !== false });
        return Promise.resolve({});
      },
    },
    windows: {
      create: ({ url }) => Promise.resolve({ id: __openReaders([].concat(url)) }),
      remove: (id) => { __closeReaders(id); return Promise.resolve(); },
    },
  };
}

// リベシティの中の別の枠(iframe)では動かない。動くのは普通のページと、裏読みの画面だけ
if (!__IS_TOP && !__READER) return;
const __PROFILE_ICON = "data:image/webp;base64,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";
const __TOGGLE_ICON = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAALeUlEQVR42s2ae5BU9ZXHP+d37+3u6eluYJhheMnwNCqirvIal0oIBkJl45qlBE0ZoiFx3Y3Lxt1aUwm6YV1UkjVrpVYlRiXCSjTquvgi0QSXbKIYESo8RahxeAQDzDAzzqNft+/9nf2juwfGMDCDrOFU/aq6q+/v/M77e36nr9BPUlUHECAUEeUskKoK4AAqIiH/X1Q6qNfv5wrPUx6kqjNU9XpVHfBRDzyBZ0JVr1PVmWdNCVUVVTWl5S1dutSo6jde/c0WXfbAE3q0uW2XqlarqlNapp+rvG9gS2v7lnt/+JS+vOEtVdUlpbO9E56V/gjt9rah8eAf9o795BctiYvT/7H6BVXVa8+CoeY++vQrSuqS7LCp8+zuhv2/9xynz7K5Jz5QSsoAoKNDa5JJEqWEVcBs393ggUps2BDvSHOLBcaq6pgSn6Cfspf3jD/a3GIrhta4rjHS3pl2/CC4EMidcHZaRJrKZyxdutTcddddtluBsvDz5893nnnmmb8GvgxckM1kKgHC0IpjDBHPc/y8DyJeJtOF7/v35rK5e1zXLZ3TPwqCkFgsKtls2gCmEBSIet7QbCazPQxDHMdRgIp4PKOqe4E1zz777MMLFizwVdWIiHXLH44c6aytrU08DXzqkSdf5L9efZ3Go22oKkFoSSYquP+fFhHxXApBQLIyzr89vtb5/o//m5qqAYTW9kt4xwjH2jr4+vWfJxmvoBCGeK7haMsH8tV/echtbm3H81xElbohgwbM+0z9lL+9cd6U+fPnf7GlpWWBiPxeVY0LsGHDvlhtbeLloy3tk+cuvK2w9Z0DzvCkI5fGfeJiKYSWlK0kGvpiRUogYDgv18QV7bu1yh1MGPYvghzHoa29lbr8ZGmOjkAAi8HTgMs6G/RYeyue55KzwvbDEf7uN1t0xZq14c9W3z+9bnjNz3bu3FkPZFwRsap6GzB57g23+dv2H47ccb7l1sRBhhofEVBrkXicvW5AQQUXJW0NNw5uZuGo98QM6oB+egBxsIlmzOAmluTPw0EJVBjshKwcsV+0ohVxXVSh2Xo8nB4hyw4eM5/90m3+zvU/uXjixInfEpE7zYYN+2LAzQ+ues5uffeA+891We5O7aVKfLqsoTN06AgNgTVYVYwRRAQjoBbaQ4dOa+gM+7ms0B462LDIS0QwRlAUaw0doaHTOnRZQ0oCvpNqYFldF3v2HXHvW/GEBRb99rd7U2bmzNEXAaPXvLTBjBnomm9UHiJrXfIqGPT4EkGNQyadwc/nyecLiOth1GKg57N9WhT3ui55v4Cfz5NNZ1AMRnqeXVDIhB63Vh7ioirHPPnzXxtVHTZt2oRLDVCTyWTNvqNtOrUyT5XxKWA4XokVcVxybS2McjJ8eu4cBo8Yyeevqsc27EQiUVA9EwBAojHChp187pOTGTKqjhmzZzGuIiR7rAnxvG6+BiggJKXA9HiOg83ttrMzDVBTLqOEqlSKLVbeD4crYI2Dt/JO1iy8k/arb2XI1jV0vb0BJ5Hqf/wDqMWJJ8hue5OZIx9l2/23kCxkkJVLKFhFuiHguAwIVJoQq4qWlHN78DzFYRKJUjh8EFn+FQZGY3RmMpgzFb5M1iIVlXS9uIrU+mcI/TxWHCRaUUywk4lyEjTsu8sjMSCGrxaTHAg2PBtdIiY5kIINIZYoWlptv+D8jzTU3rxxAmO1Z7FtL/NS22sU9CaT++FYF1E8URyUc4lMSTbTmwIC+Bg6iNGJc84pECIEBORxetQZt/xj0rG88kEFE1pHFTP83JIfSmCnbpRU3BKW1HCh+IPv+4wdU8enZ0zBWouInFPyW1UcY3h901b2NBzols8FMCJksnmmXPIJvnv71ziX6dvfe5jf7diDMeZDOSBC3i8QhCFhaHEc87EJVQZyzz2O/2EY9ojiIAxxHYdc3u8RHT2rkAiu4yDIx6ZAaBXXKQq0buv7bNzTxEUjB3J9/WhcIyjHmwPXcf4otN0/ZTgEVnGN0JUL+OZTW1j5qwYcI2T9kNd2Heaxr9V3J++pyuvHTqrFpHSNsGVfC59Z/kt+/KsGapJRqhJRRlTF+emb+9n0XgtGhNBq35G497ZFsSV/OiKcaZEKreIYQRBW/HIPS5/bhh9YqlMxgtACSsQt2rU1ne9/K9HL6ANjpIe7rBbvCGcSMk0dOf5xzWaefesAgyojJGJuSXjwHMOxzjzja5PUT6hBtVglQz1DBVSLMfhWwzF+vu19RlTFueHPxxCPuN3W7EsNFwTXCK/tOszf/+fbNB7tpCYVJbRKaLX7ltfUkePy0VU8enM9gyojpzWU2xd3//TN/Sx6ZCOqSiG0rHm9kSe+PoNRgyu7rXo6Hqpw9/Pbue/ld3CMMDgZJSiZ1TVCPrCk8wF/c9X5LL/uz4hH3T55uVcFFDAlxvet20XEMaTiHqqwZV8rs5evZ9UtV1I/oeakSpQT1TFCY1MXi1dvYv3Ow1QlIgjSLbznGNrSeQYnYjx001QWTB/drxDtvQppqcELLF25AlHPoRAWRywD4x7NHTn+8t838NTGfbhGSrek4wkvUpz9PLfpALPu+QX/u/sIQ1KxbsWMCEaK+TDjE7W8dsdsFkwfTWi1O+772qWevHeSovuTMZfPThpOU3sWrwRugVUqIg5G4KuPvsmytdsxpcpUCC2mVMv/Yc1mvvzDN0jnAwbGIxRKieo6Qq4Q0pUrsOSai1l3+yzG1yaPVyjhzC80PbSTomXvve5yOnMBP9nYSHUihlJMPGOEQZURlq3dTsPRTh66aSqJmMfvDrSyeNUm3m5soToZxWpRaQEcR2jp8hlTU8kPFk5hzqThKMfDjTMYsHIqL4CQiLk8fsuVjK9Ncs8LO0jGXFzHFCuIKkMGVPDkxn0c68wzZ9IwvvvSTrpyAUNSsW6rO6YISM0deeZNGcUPFk6hdkCMoGR1c4bA4vahDUe1iAV3fGES42qTLF69iYwfUBlxCWxxdjokFeONvU38z64jpCo8UhXeCSFj6MwW8FzD92+4gsVzLjjeB5mP1rb3Ccik1I8EVrm+fjSjaxLc9KM3ONSSZlBllEJoCa0Sj7hURotJHJYS2YhwrCPHJXWDePDGqUwdV13CBc4oZD5SL+SaohLTx1ez/tuzmTa+hqaOXHc3abUouJZDJlRau/Ismjme15bMZuq4agKrpYSXs3ZXpr9KhFYZWRVn3e2z+NKMsTR15HBEumPZcwwd2QIRz+Gxm69kxVemkYx5ZyVkTj2V6KNVnFLdj3kOK2+uZ9yQBHc/vwPXEVxj6MwV+NSFtTx44zQuGJ4qVqySgh/5anyS+4BICVRyef+EOd5pXCfF9kBRllwzifOHpnjgF++S8UOuueI8vnX1RFzHnLbV6MedHqD7RlZSRFygPR6L6MhhNfL2jncJghApWfh0pU0EBMFa5dppdVw7ra5Hg1fu+c/CH4GAoKq8tXU3w2sHS6IiCtBuGhsb3wGarv2LWbp7+x595KkXcYwpInFoCcOQMAwJTrGsWvxCQBCGgJIvBARBiFp7yn2nWmH3KuGIY1j93Cts2bxd/2ruTIyRD947cmR7WcMH0jlfx8yY78fOv0pXPLFWc3lfzxXyCwVd+fQ6TVw0R0dM/YLf1pFWVX0cQFTVNDYerRk7tnbrjj37hl696JuFA+8ddC+7fKJMufRCKitiJ6AyH/ukIpvLs3nHu2zZvFOHnTcseP6x5d7USy5off/91stGjKg6JOV/KdO+PznueS+kc4Xh9z6wirWv/ppDh5us/VNO6UpAOLy2Wq6ePUPuWHwTAxMVzdlCYV48EnldVU35XQUjIra5OT28ujr+HeCa0NqhXZk85wIlKqI4jmkGXmpra/vXqqqqA2WZ5YRMNyJiAfbu/UPNhAnDJgJV58hA7oNd+/e/c/GYMUfKr/yUX8v5P94Q82eWDrw6AAAAAElFTkSuQmCC";
const __PANEL_CSS = "\n  :host {\n    color-scheme: light dark;\n    --bg:#f5f7fa; --surface:#ffffff; --surface-soft:#f8fafc; --fg:#172033;\n    --muted:#687386; --line:#dde3ec; --line-strong:#c9d2df; --accent:#1769aa;\n    --accent-hover:#10578f; --accent-soft:#e9f3fb; --danger:#b42318; --danger-soft:#fff1f0;\n    --star:#9a5b00; --star-bg:#fff8e7; --focus:#0b78c8; --success:#18794e; --success-soft:#eaf7f0;\n  }\n  @media (prefers-color-scheme: dark) {\n    :host {\n      --bg:#11161d; --surface:#181f29; --surface-soft:#202834; --fg:#edf2f7;\n      --muted:#a9b4c3; --line:#303b49; --line-strong:#455264; --accent:#58a9df;\n      --accent-hover:#76bbe7; --accent-soft:#173247; --danger:#ff8d86; --danger-soft:#3a2325;\n      --star:#ffd078; --star-bg:#30291d; --focus:#7fc8f5; --success:#65d6a2; --success-soft:#193328;\n    }\n  }\n  * { box-sizing:border-box; }\n  .lef-app { width:100%; min-width:300px; height:100%; overflow:hidden; }\n  .lef-app { margin:0; display:flex; flex-direction:column; background:var(--bg); color:var(--fg); font:12px/1.35 system-ui, \"Segoe UI\", \"Hiragino Sans\", \"Yu Gothic UI\", sans-serif; }\n  button { font:inherit; color:inherit; }\n  button:focus-visible { outline:3px solid color-mix(in srgb, var(--focus) 65%, transparent); outline-offset:2px; }\n  .app-header { min-height:50px; padding:7px 8px; display:flex; align-items:center; gap:8px; background:var(--surface); border-bottom:1px solid var(--line); flex:none; }\n  .profile-button { width:38px; height:38px; padding:0; flex:none; border:0; border-radius:50%; background:none; cursor:pointer; position:relative; }\n  .profile-button:hover .profile-icon { filter:brightness(.92); }\n  .profile-button::after { content:\"\\270E\"; position:absolute; right:-2px; bottom:-2px; width:15px; height:15px; display:grid; place-items:center; border-radius:50%; background:var(--accent); color:#fff; font-size:9px; opacity:.9; }\n  .profile-button:hover::after, .profile-button:focus-visible::after { opacity:1; }\n  .profile-icon { width:34px; height:34px; border-radius:50%; border:2px solid var(--accent); object-fit:cover; display:block; margin:2px; }\n  .view { min-height:0; flex:1; display:flex; flex-direction:column; }\n  .view[hidden] { display:none; }\n  .set-check { display:flex; align-items:flex-start; gap:6px; margin-top:6px; font-size:11px; cursor:pointer; }\n  .set-check input { width:15px; height:15px; margin:0; flex:none; accent-color:var(--accent); }\n  .set-input, .fold textarea { width:100%; min-width:0; padding:6px 7px; border:1px solid var(--line-strong); border-radius:5px; background:var(--surface-soft); color:var(--fg); font:11px/1.4 system-ui, \"Segoe UI\", sans-serif; }\n  .fold textarea { resize:vertical; }\n  .fold .set-input, .fold textarea { width:calc(100% - 18px); }\n  .set-label { display:block; margin:7px 0 3px; color:var(--muted); font-size:10px; font-weight:700; }\n  .segmented { display:grid; grid-template-columns:repeat(3, 1fr); border:1px solid var(--line-strong); border-radius:7px; overflow:hidden; }\n  .segmented button { min-height:36px; border:0; background:var(--surface-soft); cursor:pointer; font-size:11.5px; font-weight:700; color:var(--muted); }\n  .segmented button + button { border-left:1px solid var(--line-strong); }\n  .segmented button.on { background:var(--accent); color:#fff; }\n  .segmented label { min-height:30px; display:grid; place-items:center; cursor:pointer; background:var(--surface-soft); font-size:10.5px; font-weight:700; color:var(--muted); }\n  .segmented label + label { border-left:1px solid var(--line-strong); }\n  .segmented input { position:absolute; opacity:0; pointer-events:none; }\n  .segmented label:has(input:checked) { background:var(--accent); color:#fff; }\n  #prefChips { margin-top:6px; display:grid; gap:4px; }\n  .pref-region { display:flex; flex-wrap:wrap; align-items:center; gap:3px; }\n  .pref-region__name { width:100%; color:var(--muted); font-size:9.5px; font-weight:700; }\n  .chip { min-height:24px; padding:0 7px; border:1px solid var(--line); border-radius:12px; background:var(--surface-soft); cursor:pointer; font-size:10.5px; }\n  .chip.on { background:var(--accent); border-color:var(--accent); color:#fff; font-weight:700; }\n  .group { margin-bottom:6px; padding:6px; border:1px solid var(--line); border-radius:6px; background:var(--surface-soft); display:grid; gap:5px; }\n  .group-head { display:flex; gap:5px; }\n  .group-head .gname { flex:1; min-width:0; padding:5px 7px; border:1px solid var(--line-strong); border-radius:5px; background:var(--surface); color:var(--fg); font:700 11px system-ui, sans-serif; }\n  .group textarea { background:var(--surface); }\n  .small-button { min-height:28px; padding:0 9px; border:1px solid var(--line-strong); border-radius:5px; background:var(--surface-soft); cursor:pointer; font-size:10.5px; }\n  .small-button:hover { background:var(--accent-soft); }\n  .del { min-height:26px; padding:0 8px; border:1px solid var(--line); border-radius:5px; background:transparent; color:var(--danger); cursor:pointer; font-size:10px; }\n  .swatches { display:flex; flex-wrap:wrap; gap:3px; }\n  .sw { width:18px; height:18px; padding:0; border:2px solid transparent; border-radius:50%; cursor:pointer; box-shadow:inset 0 0 0 1px rgba(0,0,0,.12); }\n  .sw.none { background:repeating-linear-gradient(45deg, var(--surface) 0 3px, var(--line) 3px 6px); }\n  .sw.on { border-color:var(--fg); transform:scale(1.12); }\n  .kind-color { display:grid; grid-template-columns:56px 1fr; align-items:center; gap:5px; margin-top:5px; font-size:10.5px; }\n  .row-buttons { display:flex; flex-wrap:wrap; gap:5px; }\n  .copy-row { display:flex; flex-wrap:wrap; align-items:center; gap:5px; margin-top:6px; font-size:10px; }\n  .copy-row code { word-break:break-all; font-size:9.5px; }\n  details.inner summary { cursor:pointer; color:var(--muted); font-size:10.5px; margin-top:8px; }\n  #saved { min-height:0; margin-top:4px; color:var(--success); font-size:10.5px; font-weight:700; text-align:center; }\n  #saved:empty { display:none; }\n  .danger-link { color:var(--danger); }\n  .brand { min-width:0; flex:1; }\n  .brand h1 { margin:0; font-size:13px; line-height:1.25; font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }\n  .brand p { margin:2px 0 0; color:var(--muted); font-size:10px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }\n  .icon-button { width:36px; height:36px; padding:0; display:grid; place-items:center; flex:none; cursor:pointer; border:1px solid var(--line); border-radius:7px; background:var(--surface-soft); }\n  .icon-button:hover { border-color:var(--line-strong); background:var(--accent-soft); }\n  .icon-button svg { width:18px; height:18px; fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }\n  .manual-button { height:36px; padding:0 7px; display:flex; align-items:center; gap:4px; flex:none; color:var(--fg); text-decoration:none; border:1px solid var(--line); border-radius:7px; background:var(--surface-soft); font-size:10px; font-weight:700; }\n  .manual-button:hover { border-color:var(--line-strong); background:var(--accent-soft); }\n  .manual-button:focus-visible { outline:3px solid color-mix(in srgb, var(--focus) 65%, transparent); outline-offset:2px; }\n  .manual-button svg { width:15px; height:15px; fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }\n  #status { min-height:27px; padding:5px 8px 5px 22px; position:relative; flex:none; color:var(--muted); background:var(--surface); border-bottom:1px solid var(--line); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-size:11px; }\n  #status::before { content:\"\"; position:absolute; left:9px; top:10px; width:7px; height:7px; border-radius:50%; background:var(--accent); }\n  #status.error { color:var(--danger); background:var(--danger-soft); }\n  #status.error::before { background:var(--danger); }\n  .search-box { flex:none; background:var(--surface); border-bottom:1px solid var(--line); }\n  .topic-row { padding:6px 8px 0; display:grid; grid-template-columns:auto minmax(0, 1fr); align-items:center; gap:6px; color:var(--muted); font-size:10.5px; font-weight:700; }\n  .topic-row select { width:100%; min-width:0; height:32px; padding:0 7px; border:1px solid var(--line-strong); border-radius:6px; background:var(--surface-soft); color:var(--fg); font:11.5px system-ui, \"Segoe UI\", sans-serif; }\n  .topic-row select:focus { outline:3px solid color-mix(in srgb, var(--focus) 30%, transparent); border-color:var(--focus); }\n  #detailFold .filter-grid { margin-bottom:9px; }\n  .search-row { min-height:42px; padding:5px 8px; display:grid; grid-template-columns:minmax(0, 1fr) auto; gap:5px; }\n  .search-input-wrap { min-width:0; position:relative; }\n  .search-input-wrap svg { width:16px; height:16px; position:absolute; left:9px; top:8px; pointer-events:none; fill:none; stroke:var(--muted); stroke-width:2; stroke-linecap:round; }\n  .search-input-wrap input { width:100%; height:32px; padding:0 30px; border:1px solid var(--line-strong); border-radius:6px; background:var(--surface-soft); color:var(--fg); font:inherit; }\n  .search-input-wrap input:focus { outline:3px solid color-mix(in srgb, var(--focus) 30%, transparent); border-color:var(--focus); }\n  .clear-search { width:28px; height:28px; padding:0; position:absolute; right:2px; top:2px; border:0; border-radius:5px; background:transparent; color:var(--muted); cursor:pointer; font-size:18px; line-height:1; }\n  .clear-search:hover { background:var(--accent-soft); color:var(--fg); }\n  .filter-toggle { height:32px; padding:0 10px; display:flex; align-items:center; gap:5px; border:1px solid var(--accent); border-radius:7px; background:var(--accent); color:#fff; cursor:pointer; font-weight:700; font-size:11.5px; white-space:nowrap; }\n  .filter-toggle:hover { background:var(--accent-hover); border-color:var(--accent-hover); }\n  .filter-toggle svg { width:15px; height:15px; fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }\n  .filter-count { min-width:17px; height:17px; padding:0 4px; display:inline-grid; place-items:center; border-radius:9px; background:#fff; color:var(--accent); font-size:10px; line-height:1; }\n  .filter-count:empty { display:none; }\n  .filter-panel { max-height:62vh; overflow-y:auto; padding:7px 8px 8px; border-top:1px solid var(--line); background:var(--surface-soft); }\n  .fold { margin-top:6px; border:1px solid var(--line); border-radius:6px; background:var(--surface); }\n  .fold > summary { min-height:32px; padding:7px 9px; cursor:pointer; font-size:11px; font-weight:700; color:var(--fg); margin:0; }\n  .fold[open] > summary { border-bottom:1px solid var(--line); }\n  .fold > :not(summary) { margin-left:9px; margin-right:9px; }\n  .fold > :last-child { margin-bottom:9px; }\n  .fold .hint { margin:7px 9px 6px; color:var(--muted); font-size:10px; line-height:1.5; }\n  .fold-value { margin-left:4px; color:var(--accent); font-weight:400; font-size:10.5px; }\n  .field-note { grid-column:1 / -1; margin:-2px 0 0; color:var(--muted); font-size:9.5px; line-height:1.45; }\n  #kindMode { margin-bottom:2px; }\n  .filter-panel[hidden] { display:none; }\n  .scope-switch { display:grid; grid-template-columns:1fr 1fr; margin-bottom:7px; border:1px solid var(--line-strong); border-radius:6px; overflow:hidden; }\n  .scope-switch label { min-height:30px; display:grid; place-items:center; cursor:pointer; background:var(--surface); font-size:10.5px; font-weight:700; }\n  .scope-switch label + label { border-left:1px solid var(--line-strong); }\n  .scope-switch input { position:absolute; opacity:0; pointer-events:none; }\n  .scope-switch label:has(input:checked) { color:#fff; background:var(--accent); }\n  .filter-grid { display:grid; grid-template-columns:1fr 1fr; gap:6px; }\n  .filter-field { min-width:0; display:grid; gap:3px; color:var(--muted); font-size:9.5px; font-weight:700; }\n  .filter-field input, .filter-field select { width:100%; min-width:0; height:31px; padding:0 7px; border:1px solid var(--line); border-radius:5px; background:var(--surface); color:var(--fg); font:11px system-ui, \"Segoe UI\", sans-serif; }\n  .date-fields { grid-column:1 / -1; display:grid; grid-template-columns:1fr auto 1fr; align-items:end; gap:5px; }\n  .date-fields > span { padding-bottom:8px; color:var(--muted); }\n  .weekdays { grid-column:1 / -1; display:grid; grid-template-columns:repeat(7, 1fr); gap:3px; }\n  .weekdays label { min-width:0; height:29px; display:grid; place-items:center; border:1px solid var(--line); border-radius:5px; background:var(--surface); cursor:pointer; color:var(--muted); font-size:10px; }\n  .weekdays input { position:absolute; opacity:0; pointer-events:none; }\n  .weekdays label:has(input:checked) { color:#fff; border-color:var(--accent); background:var(--accent); font-weight:700; }\n  .filter-foot { margin-top:7px; display:flex; align-items:center; justify-content:space-between; gap:6px; }\n  .save-conditions { flex:1; min-height:38px; display:flex; align-items:center; justify-content:center; gap:6px; border:1px solid var(--accent); border-radius:7px; background:var(--accent); color:#fff; cursor:pointer; font-size:12px; font-weight:700; }\n  .fold-conditions { flex:none; min-height:38px; padding:0 11px; display:flex; align-items:center; gap:4px; border:1px solid var(--line-strong); border-radius:7px; background:var(--surface); color:var(--fg); cursor:pointer; font-size:11.5px; font-weight:700; }\n  .fold-conditions:hover { background:var(--accent-soft); border-color:var(--accent); }\n  .fold-conditions svg { width:15px; height:15px; fill:none; stroke:currentColor; stroke-width:2.2; stroke-linecap:round; stroke-linejoin:round; }\n  .save-conditions:hover { background:var(--accent-hover); border-color:var(--accent-hover); }\n  .save-conditions svg { width:16px; height:16px; fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }\n  #summary { min-height:34px; padding:4px 8px; display:flex; align-items:center; gap:5px; flex-wrap:wrap; flex:none; background:var(--surface); border-bottom:1px solid var(--line); color:var(--muted); font-size:10.5px; }\n  #summary:empty { display:none; }\n  #summary span { padding:2px 6px; border:1px solid var(--line); border-radius:4px; background:var(--surface-soft); white-space:nowrap; }\n  #summary b { color:var(--fg); font-size:11px; }\n  #legend { padding:4px 8px; display:flex; align-items:center; gap:5px 9px; flex-wrap:wrap; flex:none; background:var(--surface-soft); border-bottom:1px solid var(--line); color:var(--muted); font-size:10.5px; }\n  #legend span { display:inline-flex; align-items:center; gap:4px; min-width:0; }\n  #legend i { width:9px; height:9px; border-radius:3px; flex:none; box-shadow:inset 0 0 0 1px rgba(0,0,0,.1); }\n  #selectionBar { min-height:32px; padding:4px 8px; display:flex; align-items:center; gap:7px; flex:none; background:var(--surface); border-bottom:1px solid var(--line); color:var(--muted); font-size:10.5px; }\n  #selectionBar label { min-width:0; display:flex; align-items:center; gap:6px; cursor:pointer; }\n  #selectVisible, .event-pick { width:16px; height:16px; margin:0; accent-color:var(--accent); cursor:pointer; }\n  #selectedCount { margin-left:auto; color:var(--fg); font-weight:700; }\n  #list { list-style:none; margin:0; padding:0; min-height:0; flex:1; overflow-y:auto; overflow-x:hidden; background:var(--surface); scrollbar-gutter:stable; }\n  #list > li { min-height:30px; padding:3px 7px 3px 6px; display:grid; align-items:center; grid-template-columns:17px 43px 34px 4px minmax(0, 1fr); column-gap:5px; border-bottom:1px solid var(--line); }\n  #list > li:hover { background:var(--accent-soft); }\n  #list > li.newday { border-top:2px solid var(--line-strong); }\n  #list > li.star { background:var(--star-bg); }\n  #list > li.star:hover { filter:brightness(.98); }\n  .d, .t { color:var(--muted); font-size:10.5px; white-space:nowrap; font-variant-numeric:tabular-nums; }\n  .d.sat { color:#1769aa; } .d.sun { color:#c62828; }\n  @media (prefers-color-scheme: dark) { .d.sat { color:#79bff0; } .d.sun { color:#ff9a94; } }\n  .k { width:4px; height:18px; border-radius:2px; background:var(--line-strong); }\n  .ti { min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-size:11.5px; }\n  .ti .hit { display:inline-block; max-width:82px; margin-right:3px; padding:0 4px; overflow:hidden; text-overflow:ellipsis; border-radius:3px; color:#fff; font-size:9.5px; line-height:16px; vertical-align:-1px; font-weight:700; }\n  .ti .hit.plain { background:var(--star); color:#111; }\n  .ti .closed { margin-right:3px; color:var(--muted); font-size:10px; }\n  .empty { padding:32px 18px; color:var(--muted); text-align:center; line-height:1.7; }\n  .empty::before { content:\"\"; display:block; width:32px; height:3px; margin:0 auto 12px; border-radius:2px; background:var(--line-strong); }\n  footer { padding:6px 8px 8px; flex:none; background:var(--surface); border-top:1px solid var(--line-strong); box-shadow:0 -2px 8px rgba(23,32,51,.05); }\n  .quick-actions { display:grid; grid-template-columns:repeat(3, 1fr); gap:5px; margin-bottom:6px; }\n  .action-button { min-height:36px; padding:4px 3px; display:flex; align-items:center; justify-content:center; gap:4px; border:1px solid var(--line); border-radius:6px; background:var(--surface-soft); cursor:pointer; font-size:10.5px; }\n  .action-button:hover { border-color:var(--line-strong); background:var(--accent-soft); }\n  .action-button svg { width:15px; height:15px; flex:none; fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }\n  .primary { width:100%; min-height:40px; padding:7px 10px; display:flex; align-items:center; justify-content:center; gap:7px; border:1px solid var(--accent); border-radius:7px; background:var(--accent); color:#fff; cursor:pointer; font-weight:700; }\n  .primary:hover { background:var(--accent-hover); border-color:var(--accent-hover); }\n  .primary svg { width:17px; height:17px; fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }\n  .selected-action { background:var(--success); border-color:var(--success); }\n  .selected-action:hover { background:color-mix(in srgb, var(--success) 86%, #000); border-color:color-mix(in srgb, var(--success) 86%, #000); }\n  button:disabled { opacity:.5; cursor:not-allowed; }\n  .sr-only { width:1px; height:1px; padding:0; position:absolute; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }\n  @media (prefers-reduced-motion:no-preference) { button { transition:background-color .16s ease, border-color .16s ease, opacity .16s ease; } }\n";
const __PANEL_HTML = "\n<header class=\"app-header\">\n  <button class=\"profile-button\" id=\"profileButton\" type=\"button\" title=\"クリックで好きな画像に変える\" aria-label=\"プロフィール画像を変える\"><img class=\"profile-icon\" src=\"data:image/webp;base64,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\" width=\"34\" height=\"34\" alt=\"\"></button>\n  <input id=\"profileFile\" type=\"file\" accept=\"image/*\" hidden>\n  <div class=\"brand\"><h1>リベ イベント フィルター</h1><p>地域と興味に合う予定だけ表示</p></div>\n  <a class=\"manual-button\" href=\"https://yubokumin28.github.io/libe-event-filter-userscript/\" target=\"_blank\" rel=\"noopener\" title=\"使い方を開く\">\n    <svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M4 19.5A2.5 2.5 0 0 1 6.5 17H20\"/><path d=\"M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z\"/></svg>使い方\n  </a>\n  <button class=\"icon-button lef-close\" id=\"lefClose\" type=\"button\" title=\"閉じる(右下の丸いボタンでまた開けます)\" aria-label=\"閉じる\">×</button>\n</header>\n<div id=\"status\" role=\"status\" aria-live=\"polite\">読み込み中…</div>\n<div id=\"listView\" class=\"view\">\n<form id=\"searchBox\" class=\"search-box\" role=\"search\">\n  <label class=\"topic-row\"><span>カテゴリー</span><select id=\"topic\"><option value=\"\">すべて</option></select></label>\n  <div class=\"search-row\">\n    <label class=\"search-input-wrap\">\n      <span class=\"sr-only\">キーワード</span>\n      <svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><circle cx=\"11\" cy=\"11\" r=\"7\"/><path d=\"m20 20-4-4\"/></svg>\n      <input id=\"keyword\" type=\"search\" placeholder=\"キーワードで検索\" autocomplete=\"off\">\n      <button id=\"clearSearch\" class=\"clear-search\" type=\"button\" title=\"キーワードを消す\" aria-label=\"キーワードを消す\">×</button>\n    </label>\n    <button id=\"filterToggle\" class=\"filter-toggle\" type=\"button\" aria-expanded=\"false\" aria-controls=\"filterPanel\">\n      <svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M4 5h16M7 12h10M10 19h4\"/></svg><span id=\"filterText\">条件を広げる</span><span id=\"filterCount\" class=\"filter-count\" title=\"使っている絞り込みの数\"></span>\n    </button>\n  </div>\n  <section id=\"filterPanel\" class=\"filter-panel\" hidden>\n    <div class=\"scope-switch\" aria-label=\"検索する範囲\">\n      <label><input type=\"radio\" name=\"scope\" value=\"recommended\" checked>条件に合う予定</label>\n      <label><input type=\"radio\" name=\"scope\" value=\"all\">読み取った全予定</label>\n    </div>\n    <div class=\"segmented autosave\" id=\"kindMode\" role=\"group\" aria-label=\"イベントの種類\">\n      <button type=\"button\" data-mode=\"offline\">オフライン</button>\n      <button type=\"button\" data-mode=\"online\">オンライン</button>\n      <button type=\"button\" data-mode=\"both\">両方</button>\n    </div>\n    <details class=\"fold\" id=\"detailFold\">\n    <summary>日付・場所・曜日 <span class=\"fold-value\" id=\"detailSummary\"></span></summary>\n    <div class=\"filter-grid\" style=\"margin-top:7px\">\n      <div class=\"date-fields\">\n        <label class=\"filter-field\">開始日<input id=\"dateFrom\" type=\"date\"></label>\n        <span>から</span>\n        <label class=\"filter-field\">終了日<input id=\"dateTo\" type=\"date\"></label>\n      </div>\n      <p class=\"field-note\" id=\"readRange\">「更新」で終了日の月まで読み取ります（最大6か月）。空欄なら今月と来月です。</p>\n      <label class=\"filter-field\">場所<input id=\"place\" type=\"search\" placeholder=\"例: 宇都宮\"></label>\n      <label class=\"filter-field\">種類・興味の言葉<select id=\"category\"><option value=\"\">すべて</option></select></label>\n      <div class=\"weekdays\" aria-label=\"曜日\">\n        <label><input type=\"checkbox\" name=\"weekday\" value=\"1\">月</label>\n        <label><input type=\"checkbox\" name=\"weekday\" value=\"2\">火</label>\n        <label><input type=\"checkbox\" name=\"weekday\" value=\"3\">水</label>\n        <label><input type=\"checkbox\" name=\"weekday\" value=\"4\">木</label>\n        <label><input type=\"checkbox\" name=\"weekday\" value=\"5\">金</label>\n        <label><input type=\"checkbox\" name=\"weekday\" value=\"6\">土</label>\n        <label><input type=\"checkbox\" name=\"weekday\" value=\"0\">日</label>\n      </div>\n    </div>\n    </details>\n    <details class=\"fold autosave\">\n      <summary>残したい地域 <span class=\"fold-value\" id=\"regionsSummary\"></span></summary>\n      <p class=\"hint\">開催場所にこの語が入る予定を残します。都道府県を押すと追加・解除できます。空欄なら全国の予定を出します。</p>\n      <input class=\"set-input\" type=\"text\" id=\"regions\" placeholder=\"例: 栃木, 東京\" aria-label=\"地域の語\">\n      <div id=\"prefChips\" aria-label=\"都道府県から選ぶ\"></div>\n      <label class=\"set-check\"><input type=\"checkbox\" id=\"regionStarOnly\"><span>地域の予定も「興味の言葉」に当たるものだけ出す</span></label>\n    </details>\n    <details class=\"fold autosave\">\n      <summary>興味の言葉と色</summary>\n      <p class=\"hint\">題名に入る言葉を★で目立たせ、Googleカレンダーでも同じ色にします。言葉はカンマか改行で区切ります。</p>\n      <label class=\"set-check\"><input type=\"checkbox\" id=\"onlineStarOnly\"><span>オンラインは、この言葉に当たる予定だけ出す</span></label>\n      <div id=\"groups\"></div>\n      <button type=\"button\" id=\"addGroup\" class=\"small-button\">＋ グループを追加</button>\n      <span class=\"set-label\">★に当たらない予定の色</span>\n      <div class=\"kind-color\"><span>オフライン</span><div class=\"swatches\" id=\"kindOffline\"></div></div>\n      <div class=\"kind-color\"><span>オンライン</span><div class=\"swatches\" id=\"kindOnline\"></div></div>\n    </details>\n    <details class=\"fold autosave\">\n      <summary>隠すもの</summary>\n      <span class=\"set-label\" style=\"margin-top:0\">除外する言葉（題名に入る予定は出しません）</span>\n      <textarea id=\"excludeWords\" rows=\"2\" placeholder=\"例: せどり, 婚活\"></textarea>\n      <label class=\"set-check\"><input type=\"checkbox\" id=\"hideClosed\"><span>受付終了は隠す</span></label>\n      <label class=\"set-check\"><input type=\"checkbox\" id=\"hidePast\"><span>開始時刻を過ぎたものは隠す</span></label>\n    </details>\n    <details class=\"fold\">\n      <summary>Googleカレンダー</summary>\n      <p class=\"hint\">緑のボタンで、選んだ予定を Googleカレンダーの作成画面(下書き)で開きます。日時・場所・リベシティのイベントのURLが入った状態で開くので、中身を確かめて「保存」を押してください。このツールが予定を勝手に入れたり消したりすることはありません。</p>\n    </details>\n    <div hidden><input id=\"calendarName\"><input id=\"reminderMinutes\" type=\"number\"><input id=\"googleClientId\"><button type=\"button\" id=\"disconnect\"></button><code id=\"redirectUri\"></code><button type=\"button\" id=\"copyRedirect\"></button></div>\n    <div class=\"filter-foot\"><button id=\"foldConditions\" class=\"fold-conditions\" type=\"button\" title=\"条件を閉じて一覧を広く表示します（保存はしません）\"><svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"m18 15-6-6-6 6\"/></svg>条件をたたむ</button><button id=\"saveConditions\" class=\"save-conditions\" type=\"button\" title=\"今の条件を保存します。次に開いた時もこの条件で表示します\"><svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z\"/><path d=\"M17 21v-8H7v8M7 3v5h8\"/></svg>条件を保存</button></div>\n    <div id=\"saved\" role=\"status\" aria-live=\"polite\"></div>\n  </section>\n</form>\n<div id=\"summary\" aria-label=\"イベント件数\"></div>\n<div id=\"legend\" aria-label=\"色分けの凡例\"></div>\n<div id=\"selectionBar\">\n  <label><input id=\"selectVisible\" type=\"checkbox\">表示中をすべて選ぶ</label>\n  <span id=\"selectedCount\">選択 0件</span>\n</div>\n<ul id=\"list\" aria-label=\"絞り込んだイベント一覧\"></ul>\n<footer>\n  <div class=\"quick-actions\">\n    <button class=\"action-button\" id=\"reload\" type=\"button\" title=\"リベシティのカレンダーを裏で読み直し、この一覧を最新にします\"><svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M20 11a8.1 8.1 0 0 0-15.5-2M4 4v5h5\"/><path d=\"M4 13a8.1 8.1 0 0 0 15.5 2M20 20v-5h-5\"/></svg>更新</button>\n    <button class=\"action-button\" id=\"openLibe\" type=\"button\" title=\"リベシティのイベントカレンダーを開く\"><svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2\"/><circle cx=\"9\" cy=\"7\" r=\"4\"/><path d=\"M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75\"/></svg>リベ</button>\n    <button class=\"action-button\" id=\"openGcal\" type=\"button\" title=\"Googleカレンダーを開く\"><svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><rect x=\"3\" y=\"5\" width=\"18\" height=\"16\" rx=\"2\"/><path d=\"M16 3v4M8 3v4M3 11h18\"/></svg>Google</button>\n  </div>\n  <button id=\"addSelected\" class=\"primary selected-action\" type=\"button\" disabled title=\"選んだ予定を、Googleカレンダーの作成画面(下書き)で開きます\"><svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M12 5v14M5 12h14\"/><rect x=\"3\" y=\"3\" width=\"18\" height=\"18\" rx=\"2\"/></svg><span id=\"addSelectedText\">イベントを選んでください</span></button>\n</footer>\n</div>\n";
// ---------- filter.js ----------
const __mod_filter = (() => {
const chrome = __chromeFor('lib');
// 絞り込みの共通ロジック(background / sidepanel / options から使う)

// Googleカレンダーの予定色(colorId 1〜11)。画面の色分けもこの11色から選ぶので、カレンダーと同じ色になる
const GCAL_COLORS = {
  1: { name: "ラベンダー", hex: "#7986cb" },
  2: { name: "セージ", hex: "#33b679" },
  3: { name: "ブドウ", hex: "#8e24aa" },
  4: { name: "フラミンゴ", hex: "#e67c73" },
  5: { name: "バナナ", hex: "#f6bf26" },
  6: { name: "ミカン", hex: "#f4511e" },
  7: { name: "ピーコック", hex: "#039be5" },
  8: { name: "グラファイト", hex: "#616161" },
  9: { name: "ブルーベリー", hex: "#3f51b5" },
  10: { name: "バジル", hex: "#0b8043" },
  11: { name: "トマト", hex: "#d50000" },
};
const colorHex = (id) => (GCAL_COLORS[id] || {}).hex || null;

const DEFAULT_SETTINGS = {
  regions: [],                  // 開催場所にこの語が含まれれば残す(都道府県名・オフィス名)。空なら全国
  includeOffline: true,         // オフライン(対面・オフィス開催)イベントを対象にする
  includeOnline: true,          // オンラインイベントも対象にする
  onlineStarOnly: true,         // オンラインは注目語に当たるものだけ
  regionStarOnly: false,        // 地域イベントも注目語に当たるものだけにする
  excludeWords: [],             // 題名にこの語があれば捨てる
  // 興味の言葉(旧称: 注目語)のグループ。題名に語が含まれれば★。グループごとに色(Googleカレンダーの colorId)を持つ
  // 2026-09-26 配布向けに初期値から旦那様の好み(栃木・せどり・副業)を外し、AIだけ残した
  starGroups: [
    { name: "AI", words: ["AI", "Claude", "ChatGPT"], colorId: 6 },
  ],
  // 種類の色(★に当たらない予定の色)。0 = カレンダーの既定色のまま
  kindColors: { offline: 10, online: 7 },
  hideClosed: true,             // 受付終了を隠す(受付前は残す)
  hidePast: true,               // 開始時刻を過ぎたものを隠す
  dateFrom: "",                 // 条件の開始日(一覧の絞り込み)
  dateTo: "",                   // 条件の終了日。「更新」はこの月まで読む(monthsUntil)
  calendarName: "リベ イベント",
  // 公開クライアントIDなので秘密ではない(暗黙フロー。シークレットは使わない)。2026-09-22 取得。
  googleClientId: "1030267090088-8j46vsa3o6dphas643g6gm6o6psh9t12.apps.googleusercontent.com",
  reminderMinutes: 60,
};

// カテゴリー(2026-09-25 旦那様指定の16件)。表示名はこのまま、題名に words のどれかが入れば該当。
// exclude に当たる題名は外す(例: Claude AI・Gemini は対象外)。比べる時は空白を無視する
const CATEGORIES = [
  { name: "Codexの導入・操作方法", words: ["Codex"] },
  { name: "Claude Code（Cowork）の導入・操作方法", note: "Claude AIは対象外です", words: ["Claude Code", "Cowork", "クロードコード"] },
  // ovice・Zoom は「会場」として題名に入るだけの予定が多い(実測: ovice を含む予定106件中、使い方の会は1件)。
  // 語のすぐ近くに「設定・使い方・操作」などがある時だけ当てる(2026-09-26)
  { name: "ovice(オンラインスペース)の初期設定・操作方法", words: [], pattern: /ovice.{0,12}(初期設定|設定|使い方|操作|入門|練習|ツアー|講座)|(初期設定|設定|使い方|操作|入門|初心者|はじめて|初めて).{0,6}ovice/ },
  { name: "Zoomの初期設定・操作方法", words: [], pattern: /(zoom|ズーム).{0,10}(初期設定|設定|使い方|操作|入門|練習|講座)|(初期設定|設定|使い方|操作|入門|初心者|はじめて|初めて).{0,6}(zoom|ズーム)/ },
  { name: "サブスクの見直し", words: ["サブスク"] },
  { name: "通信費の見直し", words: ["通信費"] },
  { name: "保険の見直し", words: ["保険"] },
  { name: "メルカリの導入・設定", words: ["メルカリ"] },
  { name: "創業計画書の作成方法", words: ["創業計画書"] },
  { name: "マネーフォワードクラウドの導入・設定", words: ["マネーフォワードクラウド", "マネフォクラウド"] },
  { name: "MacBookの初期設定・操作方法", words: ["MacBook"] },
  { name: "マネーフォワードMEの導入・設定", words: ["マネーフォワードME", "マネフォME"] },
  { name: "Googleアカウントの作成とGoogleサービスの使い方（Gmail／ドライブ／フォトなど）", note: "Gemini・Nano Bananaは対象外です", words: ["Googleアカウント", "Gmail", "Googleドライブ", "Googleフォト"], exclude: ["Gemini", "Nano Banana", "ナノバナナ"] },
  { name: "1Passwordの導入・設定", words: ["1Password"] },
  { name: "Googleスプレッドシートの使い方", words: ["スプレッドシート", "スプシ"] },
  { name: "支出管理表の作成方法", words: ["支出管理表"] },
];

// 終了日から「更新」で読む月数を決める(今月=1。空欄なら今月+来月の2か月。過去の日付なら今月だけ。最大6か月)
// 2026-09-26 空欄を1→2か月に。月末に開くと残り数日分しか出ず、一覧が空に見えたため
const MAX_READ_MONTHS = 6;
const DEFAULT_READ_MONTHS = 2;
function monthsUntil(dateTo, today = new Date()) {
  const m = String(dateTo || "").match(/^(\d{4})-(\d{2})/);
  if (!m) return DEFAULT_READ_MONTHS;
  const diff = (+m[1] - today.getFullYear()) * 12 + (+m[2] - (today.getMonth() + 1)) + 1;
  return Math.min(MAX_READ_MONTHS, Math.max(1, diff));
}

async function loadSettings() {
  const { settings } = await chrome.storage.sync.get("settings");
  const s = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  // 空欄で保存されていたら焼き込みのIDを使う(旧版で空のまま保存した人)
  if (!s.googleClientId) s.googleClientId = DEFAULT_SETTINGS.googleClientId;
  // 旧版(注目語が1本のリスト)からの引き継ぎ: グループ1つにまとめる
  if (!Array.isArray(s.starGroups) && Array.isArray(s.starWords)) {
    s.starGroups = [{ name: "注目", words: s.starWords, colorId: 5 }];
  }
  s.kindColors = { ...DEFAULT_SETTINGS.kindColors, ...(s.kindColors || {}) };
  return s;
}

async function saveSettings(s) {
  await chrome.storage.sync.set({ settings: s });
}

// 比べる前の正規化: 全角→半角(ＡＩ→AI)・大文字→小文字・前後の空白を落とす
const norm = (s) => String(s || "").normalize("NFKC").toLowerCase().trim();

// 題名が当たるカテゴリー名を全部返す。カテゴリー名そのものが題名にある時も当てる
const squash = (s) => norm(s).replace(/\s+/g, "");
function categoriesOf(title) {
  const t = squash(title);
  return CATEGORIES.filter((c) => {
    if ((c.exclude || []).some((w) => t.includes(squash(w)))) return false;
    if (c.pattern && c.pattern.test(t)) return true;
    return [c.name, ...c.words].some((w) => t.includes(squash(w)));
  }).map((c) => c.name);
}

function words(list) {
  return (list || []).map((w) => String(w).trim()).filter(Boolean);
}

function groupsOf(s) {
  if (Array.isArray(s.starGroups)) return s.starGroups;
  return [{ name: "注目", words: s.starWords || [], colorId: 5 }];
}

// 題名に語が入っているか。3文字以下の英字(AI など)は単語の切れ目で見る。
// 実測(2026-09-26): 「AI」が SAMURAI・FURUMAI・SKAI・ALTERAID・Gmail・ibisPaint に当たっていた。
// 一方 YouTubeAI・SunoAI・CanvaAI は当てたいので、「小文字の直後の大文字」は切れ目とみなす
function hasWord(title, w) {
  const word = norm(w);
  if (!word) return false;
  if (!/^[a-z0-9]{1,3}$/.test(word)) return norm(title).includes(word);
  const src = String(title || "").normalize("NFKC");
  const low = src.toLowerCase();
  const isLatin = (c) => /[A-Za-z]/.test(c || "");
  for (let i = low.indexOf(word); i >= 0; i = low.indexOf(word, i + 1)) {
    const prev = src[i - 1], next = src[i + word.length];
    if (isLatin(next)) continue;
    if (!isLatin(prev) || (/[a-z]/.test(prev) && /[A-Z]/.test(src[i]))) return true;
  }
  return false;
}

// 題名に当たった興味の言葉を全部返す: [{ word, group, colorId }](設定に書いた綴りのまま返す)
function starHits(title, s) {
  const hits = [];
  for (const g of groupsOf(s)) {
    for (const w of words(g.words)) {
      if (hasWord(title, w)) hits.push({ word: w, group: g.name || "", colorId: +g.colorId || 0 });
    }
  }
  return hits;
}

// この予定の色(Googleカレンダーの colorId)。★のグループ色 > 種類の色 > 0(既定)
function colorFor(ev, hits, s) {
  const g = (hits || []).find((h) => h.colorId > 0);
  if (g) return g.colorId;
  const kc = s.kindColors || {};
  return +(ev.kind === "online" ? kc.online : kc.offline) || 0;
}

function decorateEvent(ev, s) {
  const hits = starHits(ev.title || "", s);
  return { ...ev, star: hits.length > 0, hits, colorId: colorFor(ev, hits, s) };
}

// 開始時刻を過ぎたか。リベシティの印(is_past_time)は受付終了の先の予定にも付くので使わず、日時で決める(2026-09-26 実測: 10月の受付終了521件すべてに付いていた)
function isPast(ev, now = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  if (!ev.startDate) return !!ev.past;
  if (ev.startDate !== today) return ev.startDate < today;
  if (!ev.start) return false;
  return ev.start <= `${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

function judge(ev, s, now = new Date()) {
  // 戻り値: { keep, star, hits, colorId, reason }
  const title = ev.title || "";
  const ex = words(s.excludeWords).find((w) => hasWord(title, w));
  if (ex) return { keep: false, star: false, hits: [], colorId: 0, reason: `除外語「${ex}」` };

  if (s.hideClosed && ev.status === "受付終了") return { keep: false, star: false, hits: [], colorId: 0, reason: "受付終了" };
  if (s.hidePast && isPast(ev, now)) return { keep: false, star: false, hits: [], colorId: 0, reason: "開始済み" };

  const hits = starHits(title, s);
  const star = hits.length > 0;
  const colorId = colorFor(ev, hits, s);
  const out = (keep, reason) => ({ keep, star, hits, colorId, reason });

  if (ev.kind === "online") {
    if (!s.includeOnline) return out(false, "オンライン対象外");
    if (s.onlineStarOnly && !star) return out(false, "オンラインは興味の言葉のみ");
    return out(true, "オンライン");
  }

  if (!s.includeOffline) return out(false, "オフライン対象外");
  const place = norm(ev.place);
  // 地域が空欄なら全国を残す(初めて入れた人が0件にならないように。2026-09-26)
  const regions = words(s.regions);
  // 「全オフィス共通」(各オフィスで同時開催)は、どの地域を選んでいても出す(2026-09-26 旦那様決定)
  const hit = !regions.length ? "全国" : ev.place === "全オフィス共通" ? "全オフィス共通" : regions.find((r) => place.includes(norm(r)));
  if (!hit) return out(false, `地域外(${ev.place || "不明"})`);
  if (s.regionStarOnly && !star) return out(false, "地域は興味の言葉のみ");
  return out(true, hit);
}

function applyFilter(events, s, now = new Date()) {
  // closedIds: 受付終了・開始済みで落としたもの。すでにカレンダーに入っていれば消さない
  // (参加予定の予定が勝手に消えるのを防ぐ)
  const kept = [], dropped = {}, closedIds = [];
  for (const ev of events) {
    const j = judge(ev, s, now);
    if (j.keep) kept.push({ ...ev, star: j.star, hits: j.hits, colorId: j.colorId });
    else {
      dropped[j.reason] = (dropped[j.reason] || 0) + 1;
      if (j.reason === "受付終了" || j.reason === "開始済み") closedIds.push(ev.id);
    }
  }
  kept.sort((a, b) => (a.startDate + (a.start || "")).localeCompare(b.startDate + (b.start || "")));
  return { kept, dropped, closedIds };
}

return { GCAL_COLORS, colorHex, DEFAULT_SETTINGS, CATEGORIES, MAX_READ_MONTHS, DEFAULT_READ_MONTHS, monthsUntil, loadSettings, saveSettings, norm, categoriesOf, hasWord, starHits, colorFor, decorateEvent, isPast, judge, applyFilter };
})();

// ---------- search.js ----------
const __mod_search = (() => {
const chrome = __chromeFor('lib');
const { norm, categoriesOf } = __mod_filter;

const KIND_TEXT = { offline: "オフライン 対面", office: "オフィス 対面", online: "オンライン" };

function uniqueEvents(events) {
  const byId = new Map();
  for (const ev of events || []) {
    if (ev && ev.id) byId.set(ev.id, ev);
  }
  return [...byId.values()];
}

function searchEvents(events, filters = {}) {
  const keywords = norm(filters.keyword).split(/\s+/).filter(Boolean);
  const placeWords = norm(filters.place).split(/\s+/).filter(Boolean);
  const weekdays = new Set((filters.weekdays || []).map(Number));
  const category = String(filters.category || "");
  const topic = String(filters.topic || "");

  return uniqueEvents(events).filter((ev) => {
    // カテゴリー名も検索対象に入れる(「サブスクの見直し」と打てば該当カテゴリーの予定が出る)
    const cats = categoriesOf(ev.title);
    if (topic && !cats.includes(topic)) return false;
    const haystack = norm([ev.title, ev.place, ev.status, KIND_TEXT[ev.kind] || ev.kind, ...cats].join(" "));
    if (keywords.some((word) => !haystack.includes(word))) return false;

    const place = norm(ev.place);
    if (placeWords.some((word) => !place.includes(word))) return false;
    if (filters.dateFrom && ev.startDate < filters.dateFrom) return false;
    if (filters.dateTo && ev.startDate > filters.dateTo) return false;

    if (weekdays.size) {
      const day = new Date(`${ev.startDate}T00:00:00`).getDay();
      if (!weekdays.has(day)) return false;
    }

    if (category.startsWith("kind:") && ev.kind !== category.slice(5)) return false;
    if (category.startsWith("group:") && !(ev.hits || []).some((hit) => hit.group === category.slice(6))) return false;
    return true;
  }).sort((a, b) => (a.startDate + (a.start || "")).localeCompare(b.startDate + (b.start || "")));
}

return { uniqueEvents, searchEvents };
})();

// ---------- content.js ----------
(() => {
const chrome = __chromeFor('content');
// リベシティ イベントカレンダーの画面(DOM)からイベント一覧を読み取り、
// background へ渡す。ページを開いた時と、月を切り替えた時に動く。
// v0.5.0: リベシティの全ページで読み込む(ページ内の移動でカレンダーへ来た時も読めるように)。読むのはカレンダーの画面だけ。
// Tampermonkey 版(2026-10-30\userscript)もこのファイルをそのまま使う。
(() => {
  // タブ(offline/online)はページ内の移動で変わることがあるので、使う時にその都度見る
  const tabNow = () => new URLSearchParams(location.search).get("tab") || "offline";
  const onCalendar = () => /\/mypage\/event_calendar\/?$/.test(location.pathname);
  // 裏読み(拡張が最小化ウィンドウで開いた時だけ URL に lef=<月数> が付く)
  const HIDDEN_MONTHS = +(new URLSearchParams(location.search).get("lef") || 0);
  // 拡張版と Tampermonkey 版を両方入れていても、先に動いた方だけが働く(一覧が2つ出ないように)。裏読みの画面では見ない
  if (window.top === window && !HIDDEN_MONTHS) {
    const root = document.documentElement;
    const me = typeof GM_info === "undefined" ? "extension" : "userscript";
    if (root.dataset.lefRunning && root.dataset.lefRunning !== me) return;
    root.dataset.lefRunning = me;
  }
  let lastSig = "";
  let timer = null;

  function currentYearMonth() {
    // 画面上の「2026年9月」表記を探す。無ければ今年で推定する。
    const m = document.body.innerText.match(/(20\d{2})\s*年\s*(\d{1,2})\s*月/);
    if (m) return { year: +m[1], month: +m[2] };
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() + 1 };
  }

  function parseTime(text) {
    // 例: "09:30〜12:00" / "00:00〜09/20 17:00" / "15:00〜翌日13:00" / "10:00〜翌々日22:00"
    const m = (text || "").match(/(\d{1,2}):(\d{2})\s*〜\s*(?:(\d{1,2})\/(\d{1,2})\s+|(翌々日|翌日))?(\d{1,2}):(\d{2})/);
    if (!m) return null;
    return {
      sh: +m[1], sm: +m[2],
      endMonth: m[3] ? +m[3] : null, endDay: m[4] ? +m[4] : null,
      plusDays: m[5] === "翌々日" ? 2 : m[5] === "翌日" ? 1 : 0,
      eh: +m[6], em: +m[7],
    };
  }

  function pad(n) { return String(n).padStart(2, "0"); }

  function extract() {
    const ym = currentYearMonth();
    const out = {};
    document.querySelectorAll(".calendar_popover").forEach((pop) => {
      const head = pop.querySelector(".popover-header p");
      const dm = head ? head.textContent.match(/(\d{1,2})\/(\d{1,2})/) : null;
      if (!dm) return;
      const month = +dm[1], day = +dm[2];
      // 12月表示で1月の日が混ざる等、年またぎを補正
      let year = ym.year;
      if (ym.month === 12 && month === 1) year += 1;
      if (ym.month === 1 && month === 12) year -= 1;

      pop.querySelectorAll("li.event_item").forEach((li) => {
        const id = li.id;
        if (!id || out[id]) return; // 複数日にまたがるものは最初(開始日)だけ取る
        const timeEl = li.querySelector(".event_time");
        const timeText = timeEl && timeEl.firstChild ? timeEl.firstChild.textContent : "";
        const t = parseTime(timeText);
        const startDate = `${year}-${pad(month)}-${pad(day)}`;
        let endDate = startDate;
        if (t && t.endMonth) {
          let ey = year;
          if (t.endMonth < month) ey += 1;
          endDate = `${ey}-${pad(t.endMonth)}-${pad(t.endDay)}`;
        } else if (t && t.plusDays) {
          const d = new Date(year, month - 1, day + t.plusDays);
          endDate = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
        }
        out[id] = {
          id,
          title: (li.querySelector(".event_title") || {}).textContent?.trim() || "",
          status: (li.querySelector(".off_meeting_status") || {}).textContent?.trim() || "",
          place: (li.querySelector(".meeting_place") || {}).textContent?.trim() || "",
          kind: li.classList.contains("is_online") ? "online"
              : li.classList.contains("is_office") ? "office" : "offline",
          past: li.classList.contains("is_past_time"),
          startDate,
          endDate,
          start: t ? `${pad(t.sh)}:${pad(t.sm)}` : null,
          end: t ? `${pad(t.eh)}:${pad(t.em)}` : null,
          month: `${ym.year}-${pad(ym.month)}`,
        };
        // 予定ごとのページへのリンクが行の中にあれば控える(Googleカレンダーの説明欄に入れる)
        const a = li.querySelector('a[href*="event="]');
        if (a) out[id].link = a.href;
      });
    });
    return { tab: tabNow(), month: `${ym.year}-${pad(ym.month)}`, hidden: HIDDEN_MONTHS > 0, events: Object.values(out) };
  }

  function send() {
    if (!onCalendar()) return false;
    const data = extract();
    if (data.events.length === 0) return false;
    const sig = data.month + ":" + data.events.length + ":" + data.events[0].id;
    if (sig === lastSig) return false;
    lastSig = sig;
    chrome.runtime.sendMessage({ type: "EVENTS_FROM_PAGE", data }).catch(() => {});
    return true;
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(send, 800);
  }

  // 裏読み: 今月を読んだら「→」で翌月へ進み、指定の月数ぶん読んで READ_DONE を返す。旦那様が自分で開いた画面では動かない
  async function readMonthsHidden(months) {
    const waitFor = async (cond, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (cond()) return true; await new Promise((r) => setTimeout(r, 300)); } return false; };
    const monthLabel = () => (document.querySelector(".change_date_area h4") || {}).textContent || "";
    await waitFor(() => document.querySelectorAll("li.event_item").length > 0 && monthLabel(), 20000);
    send();
    for (let i = 1; i < months; i++) {
      const before = monthLabel();
      const next = document.querySelectorAll(".change_date_area button.bg_darkgray")[1];
      if (!next) break;
      next.click();
      const changed = await waitFor(() => monthLabel() !== before && document.querySelectorAll(".calendar_popover .popover-header p").length > 0, 15000);
      if (!changed) break;
      await new Promise((r) => setTimeout(r, 1200)); // 描画が落ち着くのを待つ
      send();
    }
    chrome.runtime.sendMessage({ type: "READ_DONE", tab: tabNow() }).catch(() => {});
  }

  if (HIDDEN_MONTHS > 0) {
    readMonthsHidden(HIDDEN_MONTHS);
  } else {
    // 初回 + 描画の変化(月切替など)を監視
    const obs = new MutationObserver(schedule);
    obs.observe(document.body, { childList: true, subtree: true });
    schedule();
  }

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg && msg.type === "READ_NOW") {
      lastSig = "";
      reply(extract());
    }
  });
})();

})();
// 裏読みの画面は読むだけ。拡張版が先に動いている時も、ここから先(パネル)は出さない
if (__READER) return;
if (document.documentElement.dataset.lefRunning !== 'userscript') return;
// ---------- panel.js ----------
// Tampermonkey 版の画面: 拡張の右サイドバー(sidepanel.html)の中身を、リベシティのページの上に浮かぶパネルに入れる。
// リベシティの見た目と混ざらないよう、Shadow DOM の中に置く。右下の丸いボタンで開け閉めし、どちらも掴んで動かせる(位置は覚える)。
// __PANEL_CSS / __PANEL_HTML / __TOGGLE_ICON は build_userscript.py が sidepanel.html と icon48.png から作って入れる。
const __US_CSS = `
:host { all: initial; }
.lef-toggle { position: fixed; z-index: 2147483000; width: 52px; height: 52px; padding: 0; border: 2px solid #fff; border-radius: 50%;
  background: #1769aa; box-shadow: 0 4px 14px rgba(0,0,0,.25); cursor: pointer; touch-action: none; display: grid; place-items: center; }
.lef-toggle img { width: 34px; height: 34px; border-radius: 8px; pointer-events: none; }
.lef-toggle:hover { filter: brightness(1.08); }
.lef-toggle.on { background: #0b8043; }
.lef-badge { position: absolute; top: -6px; right: -6px; min-width: 20px; height: 20px; padding: 0 5px; border-radius: 10px; background: #e5484d;
  color: #fff; font: 700 11px/20px system-ui, sans-serif; text-align: center; pointer-events: none; }
.lef-badge[hidden] { display: none; }
.lef-panel { position: fixed; z-index: 2147483001; width: 390px; max-width: calc(100vw - 16px); height: min(780px, calc(100vh - 24px));
  display: flex; flex-direction: column; border: 1px solid var(--line-strong); border-radius: 10px; overflow: hidden;
  box-shadow: 0 10px 34px rgba(0,0,0,.28); background: var(--bg); }
.lef-panel[hidden] { display: none !important; }
.lef-app { flex: 1; min-height: 0; }
.app-header { cursor: move; user-select: none; }
.lef-close { font-size: 20px; line-height: 1; color: var(--muted); }
#list, .filter-panel { overscroll-behavior: contain; }
.lef-drafts { position: absolute; inset: 0; z-index: 5; display: flex; flex-direction: column; background: var(--surface); color: var(--fg);
  font: 12px/1.45 system-ui, "Segoe UI", "Hiragino Sans", "Yu Gothic UI", sans-serif; }
.lef-drafts[hidden] { display: none; }
.lef-drafts header { padding: 10px 12px; border-bottom: 1px solid var(--line); background: var(--surface-soft); }
.lef-drafts h2 { margin: 0 0 4px; font-size: 14px; }
.lef-drafts p { margin: 0; color: var(--muted); font-size: 11px; }
.lef-drafts ol { list-style: none; margin: 0; padding: 0; flex: 1; overflow-y: auto; overscroll-behavior: contain; }
.lef-drafts li { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: center; padding: 8px 12px; border-bottom: 1px solid var(--line); }
.lef-drafts .when { color: var(--muted); font-size: 10.5px; }
.lef-drafts .what { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 700; }
.lef-drafts .open { min-height: 34px; padding: 0 12px; border: 1px solid var(--success); border-radius: 7px; background: var(--success); color: #fff; cursor: pointer; font-weight: 700; white-space: nowrap; }
.lef-drafts .open.done { background: var(--surface-soft); color: var(--success); }
.lef-drafts footer { padding: 8px 12px; display: flex; gap: 8px; justify-content: flex-end; border-top: 1px solid var(--line); }
.lef-drafts footer button { min-height: 34px; padding: 0 14px; border: 1px solid var(--line-strong); border-radius: 7px; background: var(--surface-soft); color: var(--fg); cursor: pointer; font-weight: 700; }
`;

const __root = document.createElement('div');
__root.id = 'lef-root';
const __shadow = __root.attachShadow({ mode: 'open' });
__shadow.innerHTML = `<style>${__PANEL_CSS}${__US_CSS}</style>
<button class="lef-toggle" id="lefToggle" type="button" title="リベ イベント フィルター(押すと一覧を開く・掴むと動かせる)" aria-label="リベ イベント フィルターを開く">
  <img src="${__TOGGLE_ICON}" alt=""><span class="lef-badge" id="lefBadge" hidden></span></button>
<div class="lef-panel" id="lefPanel" hidden role="dialog" aria-label="リベ イベント フィルター">
  <div class="lef-app">${__PANEL_HTML}</div>
  <div class="lef-drafts" id="lefDrafts" hidden></div>
</div>`;
document.body.appendChild(__root);
// リベシティのキー操作(ショートカット)に、パネルでの入力が拾われないようにする
for (const t of ['keydown', 'keyup', 'keypress']) __root.addEventListener(t, (e) => e.stopPropagation());

// 拡張の部品は document.getElementById などで画面を探すので、パネルの中を探すように差し替えた document を渡す
const __panelDoc = {
  getElementById: (id) => __shadow.getElementById(id),
  querySelector: (s) => __shadow.querySelector(s),
  querySelectorAll: (s) => __shadow.querySelectorAll(s),
  createElement: (t) => window.document.createElement(t),
};

// ---------- 開け閉め・位置(GM の lefUi に覚える。拡張には無いキー) ----------
const __toggle = __shadow.getElementById('lefToggle');
const __panel = __shadow.getElementById('lefPanel');
const __badge = __shadow.getElementById('lefBadge');
const __ui = Object.assign({ open: false }, GM_getValue('lefUi') || {});
const __saveUi = () => GM_setValue('lefUi', { ...__ui });
__badgeFn = (text) => { __badge.textContent = text || ''; __badge.hidden = !text || text === '0'; };

const __clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function __placeToggle() {
  const x = __ui.bx == null ? innerWidth - 52 - 20 : __ui.bx;
  const y = __ui.by == null ? innerHeight - 52 - 96 : __ui.by;
  __toggle.style.left = __clamp(x, 4, innerWidth - 56) + 'px';
  __toggle.style.top = __clamp(y, 4, innerHeight - 56) + 'px';
}
function __placePanel() {
  const w = __panel.offsetWidth || 390;
  const h = __panel.offsetHeight || 600;
  const x = __ui.px == null ? innerWidth - w - 16 : __ui.px;
  const y = __ui.py == null ? 64 : __ui.py;
  __panel.style.left = __clamp(x, 4, Math.max(4, innerWidth - w - 4)) + 'px';
  __panel.style.top = __clamp(y, 4, Math.max(4, innerHeight - h - 4)) + 'px';
}
function __setOpen(open) {
  __ui.open = !!open;
  __panel.hidden = !open;
  __toggle.classList.toggle('on', !!open);
  __toggle.setAttribute('aria-label', open ? 'リベ イベント フィルターを閉じる' : 'リベ イベント フィルターを開く');
  if (open) __placePanel();
  __saveUi();
}
const __togglePanel = () => __setOpen(__panel.hidden);

// 掴んで動かす。4px 以上動いたら「動かした」、それ未満なら「押した」
function __draggable(handle, target, onMove, onClick) {
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (handle !== target && e.target.closest('button, a, input, select, textarea, label')) return;
    const sx = e.clientX, sy = e.clientY;
    const ox = target.offsetLeft, oy = target.offsetTop;
    let moved = false;
    const move = (ev) => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      moved = true;
      onMove(ox + dx, oy + dy);
    };
    const up = () => {
      removeEventListener('pointermove', move, true);
      removeEventListener('pointerup', up, true);
      if (moved) __saveUi(); else if (onClick) onClick();
    };
    addEventListener('pointermove', move, true);
    addEventListener('pointerup', up, true);
    e.preventDefault();
  });
}
__draggable(__toggle, __toggle, (x, y) => { __ui.bx = x; __ui.by = y; __placeToggle(); }, __togglePanel);
__draggable(__shadow.querySelector('.app-header'), __panel, (x, y) => { __ui.px = x; __ui.py = y; __placePanel(); });
addEventListener('resize', () => { __placeToggle(); if (!__panel.hidden) __placePanel(); });
__placeToggle();

// ---------- background.js ----------
const __mod_background = (() => {
const chrome = __chromeFor('background');
// 裏方。ページから届いたイベントを保存し、選んだものだけを Googleカレンダーへ入れる。
// 2026-09-25 v0.4: 全件同期・開いた時の自動同期・6時間ごとの同期を廃止(チェックした予定だけ入れる)
const { loadSettings, applyFilter, decorateEvent, monthsUntil } = __mod_filter;
const { getToken, ensureCalendar, syncSelected } = __mod_gcal;

const CAL_URL = "https://libecity.com/mypage/event_calendar";
const GCAL_URL = "https://calendar.google.com/calendar/r/month";

// アイコンを押したら右サイドバー(Side Panel)に一覧を開く(小窓は廃止。2026-09-22)
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

async function setStatus(patch) {
  const { status } = await chrome.storage.local.get("status");
  const next = { ...(status || {}), ...patch, at: Date.now() };
  await chrome.storage.local.set({ status: next });
  chrome.runtime.sendMessage({ type: "STATUS", status: next }).catch(() => {});
  return next;
}

// ページから届いた一覧を月×タブ単位で保存。
// オフラインとオンラインの2枚が同時に届くと「読む→足す→書く」が重なり、片方の月が消える(2026-09-26 に10月分が欠けた)。
// そのため1件ずつ順番に保存する
let storeQueue = Promise.resolve();
function storeEvents(data) {
  const run = storeQueue.then(() => storeEventsNow(data));
  storeQueue = run.catch(() => {});
  return run;
}

async function storeEventsNow(data) {
  const { store } = await chrome.storage.local.get("store");
  const s = store || {};
  s[`${data.month}:${data.tab}`] = { at: Date.now(), events: data.events };
  // 先月より前の月は捨てる(溜め込まない)
  const d = new Date(); d.setMonth(d.getMonth() - 1);
  const floor = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  for (const key of Object.keys(s)) if (key.split(":")[0] < floor) delete s[key];
  await chrome.storage.local.set({ store: s });
  return s;
}

async function collectMonth(store, month) {
  const all = [];
  for (const [key, v] of Object.entries(store || {})) {
    if (key.startsWith(month + ":")) all.push(...v.events);
  }
  return all;
}

// ---- リベシティを裏で開いて読み直す(ボタン1つで最新にする) ----
const waiters = []; // { pending:Set<tab>, resolve }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function refreshFromSite(months = 1) {
  const timeoutMs = 25000 + 12000 * months;
  const pending = new Set(["offline", "online"]);
  const done = new Promise((resolve) => waiters.push({ pending, resolve }));
  // 読み直しなので前回の一覧は捨てる(失敗したら戻す)
  const { store: old } = await chrome.storage.local.get("store");
  storeQueue = storeQueue.then(() => chrome.storage.local.set({ store: {} })).catch(() => {});
  await storeQueue;
  // 旦那様のタブ列に出ないよう、最小化した別ウィンドウで開き、読めたら閉じる。lef=<月数> で裏読みを指示
  const urls = [CAL_URL + "?lef=" + months, CAL_URL + "?tab=online&lef=" + months];
  const win = await chrome.windows.create({ url: urls, state: "minimized", focused: false });
  const ok = await Promise.race([done.then(() => true), sleep(timeoutMs).then(() => false)]);
  chrome.windows.remove(win.id).catch(() => {});
  if (!ok) {
    const { store: now } = await chrome.storage.local.get("store");
    if (!now || Object.keys(now).length === 0) await chrome.storage.local.set({ store: old || {} });
  }
  return ok;
}

function notifyWaiters(tab) {
  for (const w of [...waiters]) {
    w.pending.delete(tab);
    if (w.pending.size === 0) { w.resolve(); waiters.splice(waiters.indexOf(w), 1); }
  }
}

let syncing = false;

async function addSelected(eventIds) {
  if (syncing) return setStatus({ phase: "sync", message: "同期中です。少しお待ちください" });
  const ids = new Set(eventIds || []);
  if (!ids.size) return setStatus({ phase: "idle", message: "追加するイベントを選んでください" });

  syncing = true;
  try {
    const settings = await loadSettings();
    const { store } = await chrome.storage.local.get("store");
    const found = new Map();
    for (const part of Object.values(store || {})) {
      for (const ev of part.events || []) if (ids.has(ev.id)) found.set(ev.id, decorateEvent(ev, settings));
    }
    const events = [...found.values()];
    if (!events.length) return setStatus({ phase: "idle", message: "選んだイベントが一覧から見つかりませんでした。更新してください" });

    await setStatus({ phase: "sync", message: `選んだ${events.length}件をGoogleカレンダーへ追加中…` });
    const token = await getToken(settings.googleClientId, true);
    const calId = await ensureCalendar(token, settings.calendarName);
    const stats = await syncSelected(token, calId, events, settings, (p) =>
      setStatus({ phase: "sync", message: `追加${p.added} / 更新${p.updated} / 登録済み${p.same}` }));
    return setStatus({
      phase: "done",
      message: `選択分を追加: 新規${stats.added} / 更新${stats.updated} / 登録済み${stats.same}`,
      lastSync: Date.now(),
    });
  } catch (e) {
    return setStatus({ phase: "error", message: String(e.message || e) });
  } finally {
    syncing = false;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    if (msg.type === "EVENTS_FROM_PAGE") {
      const store = await storeEvents(msg.data);
      const settings = await loadSettings();
      const events = await collectMonth(store, msg.data.month);
      const { kept } = applyFilter(events, settings);
      await setStatus({ phase: "read", message: `${msg.data.month} を読み取り: ${events.length}件 → 残り ${kept.length}件`, month: msg.data.month });
      chrome.action.setBadgeText({ text: String(kept.length) });
      chrome.action.setBadgeBackgroundColor({ color: "#2563eb" });
      reply({ ok: true });
    } else if (msg.type === "READ_DONE") {
      await storeQueue; // 保存待ちが全部終わってから「読み終わった」とする
      notifyWaiters(msg.tab);
      reply({ ok: true });
    } else if (msg.type === "SYNC_SELECTED") {
      const st = await addSelected(msg.eventIds);
      if (st && st.phase === "done") chrome.tabs.create({ url: GCAL_URL, active: true });
      reply(st);
    } else if (msg.type === "OPEN_GCAL") {
      chrome.tabs.create({ url: GCAL_URL, active: true });
      reply({ ok: true });
    } else if (msg.type === "OPEN_LIBE") {
      chrome.tabs.create({ url: CAL_URL, active: true });
      reply({ ok: true });
    } else if (msg.type === "OPEN_CALENDAR_TABS") {
      // 読む期間は条件の終了日で決まる(2026-09-25 v0.4.1。旧 syncMonths は使わない)
      const months = monthsUntil((await loadSettings()).dateTo);
      await setStatus({ phase: "read", message: `リベシティのカレンダーを裏で開いて読み取り中…(${months}か月分)` });
      const ok = await refreshFromSite(months);
      const { status } = await chrome.storage.local.get("status");
      reply(ok ? status : await setStatus({ phase: "error", message: "読み取れませんでした。リベシティにログインしているか確かめてください" }));
    } else if (msg.type === "GET_STATUS") {
      const { status } = await chrome.storage.local.get("status");
      reply(status || { phase: "idle", message: "未実行" });
    }
  })();
  return true;
});

// 更新直後は、旧版の自動同期が残したエラー表示(interaction_required など)を消す
chrome.runtime.onInstalled.addListener(() => {
  setStatus({ phase: "idle", message: "予定にチェックを入れて、緑のボタンでGoogleカレンダーの作成画面を開けます" });
});

return { collectMonth };
})();

// ---------- settings.js ----------
const __mod_settings = (() => {
const chrome = __chromeFor('panel'); const document = __panelDoc;
// 「条件」パネルの中の保存される項目(種類・地域・注目語・隠すもの・Googleカレンダー・日付)。
// 2026-09-25 v0.4.1: 別の設定画面をやめ、条件パネルに統合。変えたらその場で自動保存する
const { DEFAULT_SETTINGS, GCAL_COLORS, loadSettings, saveSettings, monthsUntil, MAX_READ_MONTHS } = __mod_filter;
const { clearToken } = __mod_gcal;

const $ = (id) => document.getElementById(id);
const PREF_GROUPS = [
  ["北海道", ["北海道"]],
  ["東北", ["青森","岩手","宮城","秋田","山形","福島"]],
  ["関東", ["茨城","栃木","群馬","埼玉","千葉","東京","神奈川"]],
  ["中部", ["新潟","富山","石川","福井","山梨","長野","岐阜","静岡","愛知"]],
  ["近畿", ["三重","滋賀","京都","大阪","兵庫","奈良","和歌山"]],
  ["中国・四国", ["鳥取","島根","岡山","広島","山口","徳島","香川","愛媛","高知"]],
  ["九州・沖縄", ["福岡","佐賀","長崎","熊本","大分","宮崎","鹿児島","沖縄"]],
];
const KIND_MODES = { offline: [true, false], online: [false, true], both: [true, true] };
const split = (s) => String(s || "").split(/[,、\n]/).map((x) => x.trim()).filter(Boolean);
const join = (a) => (a || []).join(", ");

let save = () => {};

function renderChips() {
  const cur = new Set(split($("regions").value));
  $("regionsSummary").textContent = cur.size ? `（${[...cur].join("・")}）` : "（未選択）";
  $("prefChips").innerHTML = "";
  for (const [name, prefs] of PREF_GROUPS) {
    const region = document.createElement("div");
    region.className = "pref-region";
    const heading = document.createElement("span");
    heading.className = "pref-region__name";
    heading.textContent = name;
    region.appendChild(heading);
    for (const p of prefs) {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "chip" + (cur.has(p) ? " on" : "");
      el.textContent = p;
      el.setAttribute("aria-pressed", String(cur.has(p)));
      el.onclick = () => {
        const set = new Set(split($("regions").value));
        set.has(p) ? set.delete(p) : set.add(p);
        $("regions").value = join([...set]);
        renderChips();
        save();
      };
      region.appendChild(el);
    }
    $("prefChips").appendChild(region);
  }
}

// ---- 色の選択(Googleカレンダーの11色 + なし) ----
function renderSwatches(container, value) {
  container.innerHTML = "";
  container.dataset.value = String(+value || 0);
  const pick = (id) => {
    container.dataset.value = String(id);
    container.querySelectorAll(".sw").forEach((c) => {
      const on = +c.dataset.id === id;
      c.classList.toggle("on", on);
      c.setAttribute("aria-pressed", String(on));
    });
    save();
  };
  const make = (id, title, hex) => {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "sw" + (hex ? "" : " none") + (id === (+value || 0) ? " on" : "");
    el.dataset.id = String(id);
    el.title = title;
    if (hex) el.style.background = hex;
    el.setAttribute("aria-label", title);
    el.setAttribute("aria-pressed", String(id === (+value || 0)));
    el.onclick = () => pick(id);
    container.appendChild(el);
  };
  make(0, "なし（カレンダーの既定色）", null);
  for (const [id, c] of Object.entries(GCAL_COLORS)) make(+id, c.name, c.hex);
}
const swatchValue = (container) => +(container.dataset.value || 0);

// ---- 注目語のグループ ----
function addGroupRow(g) {
  const row = document.createElement("div");
  row.className = "group";
  row.innerHTML = `<div class="group-head"><input type="text" class="gname" placeholder="グループ名(例: AI)" aria-label="グループ名"><button type="button" class="del" title="このグループを消す">削除</button></div>
    <textarea class="gwords" rows="2" placeholder="当てる言葉(例: AI, Claude, ChatGPT)" aria-label="当てる言葉"></textarea>
    <div class="swatches gcolor" aria-label="このグループの色"></div>`;
  row.querySelector(".gname").value = g.name || "";
  row.querySelector(".gwords").value = join(g.words);
  renderSwatches(row.querySelector(".gcolor"), g.colorId);
  row.querySelector(".del").onclick = () => { row.remove(); save(); };
  $("groups").appendChild(row);
}
function readGroups() {
  return [...document.querySelectorAll("#groups .group")].map((row) => ({
    name: row.querySelector(".gname").value.trim(),
    words: split(row.querySelector(".gwords").value),
    colorId: swatchValue(row.querySelector(".gcolor")),
  })).filter((g) => g.words.length);
}

function setKindMode(mode) {
  for (const b of document.querySelectorAll("#kindMode button")) {
    const on = b.dataset.mode === mode;
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", String(on));
  }
  $("kindMode").dataset.value = mode;
}
const kindModeOf = (s) => (s.includeOffline === s.includeOnline) ? "both" : s.includeOnline ? "online" : "offline";

function fill(s) {
  setKindMode(kindModeOf(s));
  $("onlineStarOnly").checked = !!s.onlineStarOnly;
  $("dateFrom").value = s.dateFrom || "";
  $("dateTo").value = s.dateTo || "";
  $("place").value = s.place || "";
  const days = new Set((s.weekdays || []).map(Number));
  for (const el of document.querySelectorAll('input[name="weekday"]')) el.checked = days.has(+el.value);
  $("regions").value = join(s.regions);
  $("regionStarOnly").checked = !!s.regionStarOnly;
  $("groups").innerHTML = "";
  (s.starGroups || []).forEach(addGroupRow);
  const kc = s.kindColors || {};
  renderSwatches($("kindOffline"), kc.offline);
  renderSwatches($("kindOnline"), kc.online);
  $("excludeWords").value = join(s.excludeWords);
  $("hideClosed").checked = !!s.hideClosed;
  $("hidePast").checked = !!s.hidePast;
  $("calendarName").value = s.calendarName;
  $("reminderMinutes").value = s.reminderMinutes;
  $("googleClientId").value = s.googleClientId || "";
  renderChips();
  showReadRange();
}

function read(prev) {
  const [includeOffline, includeOnline] = KIND_MODES[$("kindMode").dataset.value] || KIND_MODES.both;
  return {
    ...prev,
    includeOffline,
    includeOnline,
    onlineStarOnly: $("onlineStarOnly").checked,
    dateFrom: $("dateFrom").value,
    dateTo: $("dateTo").value,
    place: $("place").value.trim(),
    weekdays: [...document.querySelectorAll('input[name="weekday"]:checked')].map((el) => +el.value),
    filterCategory: $("category").value,
    topic: $("topic").value,
    regions: split($("regions").value),
    regionStarOnly: $("regionStarOnly").checked,
    starGroups: readGroups(),
    kindColors: { offline: swatchValue($("kindOffline")), online: swatchValue($("kindOnline")) },
    excludeWords: split($("excludeWords").value),
    hideClosed: $("hideClosed").checked,
    hidePast: $("hidePast").checked,
    calendarName: $("calendarName").value.trim() || DEFAULT_SETTINGS.calendarName,
    reminderMinutes: Math.max(0, +$("reminderMinutes").value || 0),
    googleClientId: $("googleClientId").value.trim(),
  };
}

function showReadRange() {
  const n = monthsUntil($("dateTo").value);
  $("readRange").textContent = !$("dateTo").value
    ? `「更新」で今月と来月の${n}か月分を読み取ります。終了日を入れると、その月まで読みます（最大${MAX_READ_MONTHS}か月）。`
    : n > 1
      ? `「更新」で今月から${n}か月分を読み取ります（1か月あたり約10秒・最大${MAX_READ_MONTHS}か月）。`
      : `「更新」で今月分を読み取ります。終了日を来月以降にすると、その月まで読みます（最大${MAX_READ_MONTHS}か月）。`;
}

function flash(msg) { $("saved").textContent = msg; setTimeout(() => ($("saved").textContent = ""), 2000); }

// ---- プロフィール画像(左上の丸を押して好きな画像を選ぶ。拡張の中だけに保存) ----
// 128px の正方形に切り抜いて縮め、chrome.storage.local に data URL で置く
function shrinkImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const size = 128;
      const side = Math.min(img.naturalWidth, img.naturalHeight);
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = size;
      canvas.getContext("2d").drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/webp", 0.88));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("画像を読み込めませんでした")); };
    img.src = url;
  });
}

function pickProfileImage() {
  $("profileFile").value = "";
  $("profileFile").click();
}

async function applyProfileImage() {
  const { profileImage } = await chrome.storage.local.get("profileImage");
  const src = profileImage || __PROFILE_ICON;
  for (const img of document.querySelectorAll(".profile-icon")) img.src = src;
}

async function initSettings() {
  let prev = await loadSettings();
  fill(prev);

  let timer = null;
  const saveNow = async () => {
    clearTimeout(timer);
    const next = read(prev);
    await saveSettings(next);
    if (prev.calendarName !== next.calendarName) await chrome.storage.local.remove("calendarId");
    prev = next;
    flash("保存しました");
  };
  save = () => {
    clearTimeout(timer);
    timer = setTimeout(saveNow, 500);
  };

  // 保存される項目は、変えたらすぐ保存する(保存ボタンは無い)
  for (const el of document.querySelectorAll(".autosave")) {
    el.addEventListener("input", save);
    el.addEventListener("change", save);
  }
  for (const id of ["dateFrom", "dateTo"]) $(id).addEventListener("input", () => { showReadRange(); save(); });
  $("regions").addEventListener("input", renderChips);
  for (const b of document.querySelectorAll("#kindMode button")) b.onclick = () => { setKindMode(b.dataset.mode); save(); };
  $("addGroup").onclick = () => addGroupRow({ name: "", words: [], colorId: 0 });
  $("disconnect").onclick = async () => { await clearToken(); await chrome.storage.local.remove("calendarId"); flash("接続を解除しました"); };

  $("profileFile").addEventListener("change", async () => {
    const file = $("profileFile").files[0];
    if (!file) return;
    try {
      await chrome.storage.local.set({ profileImage: await shrinkImage(file) });
      await applyProfileImage();
    } catch (e) {
      alert(String(e.message || e));
    }
  });

  $("redirectUri").textContent = chrome.identity.getRedirectURL();
  $("copyRedirect").onclick = async () => { await navigator.clipboard.writeText(chrome.identity.getRedirectURL()); flash("コピーしました"); };
  return { save, saveNow, showReadRange, saved: () => prev };
}

return { pickProfileImage, applyProfileImage, initSettings };
})();

// ---------- sidepanel.js ----------
const __mod_sidepanel = (() => {
const chrome = __chromeFor('panel'); const document = __panelDoc;
const { loadSettings, applyFilter, colorHex, GCAL_COLORS, decorateEvent, CATEGORIES, categoriesOf } = __mod_filter;
const { searchEvents, uniqueEvents } = __mod_search;
const { initSettings, pickProfileImage, applyProfileImage } = __mod_settings;

const $ = (id) => document.getElementById(id);
const WD = ["日", "月", "火", "水", "木", "金", "土"];
const selectedIds = new Set();
let model = { settings: null, all: [], recommended: [], visible: [], dropped: {} };

function fmtDate(iso) {
  const d = new Date(iso + "T00:00:00");
  return { text: `${d.getMonth() + 1}/${d.getDate()} ${WD[d.getDay()]}`, dow: d.getDay() };
}

function kindJa(k) { return k === "online" ? "オンライン" : k === "office" ? "オフィス" : "オフライン"; }
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

function renderLegend(settings) {
  const items = [];
  const kc = settings.kindColors || {};
  if (kc.offline > 0) items.push(`<span><i style="background:${colorHex(kc.offline)}"></i>オフライン</span>`);
  if (kc.online > 0) items.push(`<span><i style="background:${colorHex(kc.online)}"></i>オンライン</span>`);
  for (const g of settings.starGroups || []) {
    const hex = colorHex(g.colorId) || "var(--star)";
    items.push(`<span><i style="background:${hex}"></i>★ ${escapeHtml(g.name || (g.words || []).join("・"))}</span>`);
  }
  $("legend").innerHTML = items.join("");
  $("legend").style.display = items.length ? "" : "none";
}

function renderCategories(settings) {
  const select = $("category");
  const current = select.value;
  select.innerHTML = "";
  const add = (value, label) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    select.appendChild(option);
  };
  add("", "すべて");
  add("kind:offline", "オフライン");
  add("kind:office", "オフィス");
  add("kind:online", "オンライン");
  const names = new Set();
  for (const group of settings.starGroups || []) {
    const name = String(group.name || "").trim();
    if (name && !names.has(name)) {
      names.add(name);
      add(`group:${name}`, `★ ${name}`);
    }
  }
  if ([...select.options].some((option) => option.value === current)) select.value = current;
}

// カテゴリーの選択肢(表示名は CATEGORIES の name のまま)
function renderTopics() {
  const select = $("topic");
  if (select.options.length > 1) return;
  for (const c of CATEGORIES) {
    const option = document.createElement("option");
    option.value = c.name;
    option.textContent = c.name;
    if (c.note) option.title = c.note;
    select.appendChild(option);
  }
}

function readFilters() {
  return {
    keyword: $("keyword").value,
    dateFrom: $("dateFrom").value,
    dateTo: $("dateTo").value,
    place: $("place").value,
    category: $("category").value,
    topic: $("topic").value,
    weekdays: [...document.querySelectorAll('input[name="weekday"]:checked')].map((el) => +el.value),
  };
}

function activeConditionCount() {
  const filters = readFilters();
  return [filters.dateFrom, filters.dateTo, filters.place, filters.category].filter(Boolean).length
    + (filters.weekdays.length ? 1 : 0)
    + (document.querySelector('input[name="scope"]:checked')?.value === "all" ? 1 : 0);
}

function updateDetailSummary() {
  const f = readFilters();
  const parts = [];
  if (f.dateFrom || f.dateTo) parts.push(`${f.dateFrom ? +f.dateFrom.slice(5, 7) + "/" + +f.dateFrom.slice(8) : ""}〜${f.dateTo ? +f.dateTo.slice(5, 7) + "/" + +f.dateTo.slice(8) : ""}`);
  if (f.place) parts.push(f.place);
  if (f.category) parts.push($("category").selectedOptions[0]?.textContent || "");
  if (f.weekdays.length) parts.push(f.weekdays.map((d) => WD[d]).join(""));
  $("detailSummary").textContent = parts.length ? `（${parts.join("・")}）` : "";
}

function updateFilterButton() {
  updateDetailSummary();
  const count = activeConditionCount();
  // 開いている間は「条件をたたむ」、閉じている時は「条件を広げる」。数字は使っている絞り込みの数
  $("filterText").textContent = $("filterPanel").hidden ? "条件を広げる" : "条件をたたむ";
  $("filterCount").textContent = count ? String(count) : "";
}

function updateSelectionUi() {
  const visibleIds = model.visible.map((ev) => ev.id);
  const visibleSelected = visibleIds.filter((id) => selectedIds.has(id)).length;
  const master = $("selectVisible");
  master.checked = visibleIds.length > 0 && visibleSelected === visibleIds.length;
  master.indeterminate = visibleSelected > 0 && visibleSelected < visibleIds.length;
  master.disabled = visibleIds.length === 0;
  $("selectedCount").textContent = `選択 ${selectedIds.size}件`;
  $("addSelected").disabled = selectedIds.size === 0;
  $("addSelectedText").textContent = selectedIds.size ? `選んだ${selectedIds.size}件をGoogleカレンダーに入れる` : "イベントを選んでください";
}

function renderResults() {
  if (!model.settings) return;
  const scope = document.querySelector('input[name="scope"]:checked')?.value || "recommended";
  const base = scope === "all" ? model.all : model.recommended;
  const visible = searchEvents(base, readFilters());
  model.visible = visible;
  updateFilterButton();

  const months = [...new Set(model.all.map((ev) => ev.month))].sort();
  $("summary").innerHTML = model.all.length
    ? `<span>読取 <b>${model.all.length}</b>件</span><span>表示 <b>${visible.length}</b>件</span><span>★ <b>${visible.filter((ev) => ev.star).length}</b>件</span><span title="「更新」で読み取り済みの月です。表示する日付は条件の開始日・終了日で絞れます">${months.map((m) => +m.slice(5) + "月").join("・")}分を読取済み</span>`
    : "";

  const list = $("list");
  list.innerHTML = "";
  if (!model.all.length) {
    list.innerHTML = `<div class="empty">まだ一覧がありません。<br>下の「更新」を押してください。</div>`;
    updateSelectionUi();
    return;
  }
  if (!visible.length) {
    const hasSearch = $("keyword").value || activeConditionCount();
    const why = Object.entries(model.dropped).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}: ${v}`).join(" / ");
    list.innerHTML = hasSearch
      ? `<div class="empty">検索条件に合うイベントがありません。<br><small>言葉や日付を少し広げてください。</small></div>`
      : `<div class="empty">条件に合うイベントが0件でした。<br><small>${escapeHtml(why)}</small></div>`;
    updateSelectionUi();
    return;
  }

  let prevDate = "";
  for (const ev of visible) {
    const li = document.createElement("li");
    if (ev.star) li.classList.add("star");
    const newDay = ev.startDate !== prevDate;
    if (newDay && prevDate) li.classList.add("newday");
    prevDate = ev.startDate;
    const { text: dText, dow } = fmtDate(ev.startDate);
    const dCls = dow === 0 ? "sun" : dow === 6 ? "sat" : "";
    const kc = model.settings.kindColors || {};
    const kindHex = colorHex(ev.kind === "online" ? kc.online : kc.offline) || "var(--line)";
    const hits = (ev.hits || []).map((hit) => {
      const hex = colorHex(hit.colorId);
      return `<span class="hit${hex ? "" : " plain"}"${hex ? ` style="background:${hex}"` : ""}>★${escapeHtml(hit.word)}</span>`;
    }).join("");
    const closed = ev.status && ev.status !== "募集中" ? `<span class="closed">[${escapeHtml(ev.status)}]</span> ` : "";
    li.innerHTML = `<input class="event-pick" type="checkbox"><span class="d ${dCls}">${newDay ? dText : ""}</span>
      <span class="t">${ev.start || "終日"}</span><span class="k" style="background:${kindHex}" title="${kindJa(ev.kind)}"></span>
      <span class="ti">${hits}${closed}${escapeHtml(ev.title)}</span>`;
    const pick = li.querySelector(".event-pick");
    pick.checked = selectedIds.has(ev.id);
    pick.setAttribute("aria-label", `${ev.title}を選ぶ`);
    pick.addEventListener("change", () => {
      if (pick.checked) selectedIds.add(ev.id); else selectedIds.delete(ev.id);
      updateSelectionUi();
    });
    li.title = [
      `${dText} ${ev.start ? ev.start + "〜" + ev.end : "終日"}`,
      ev.title,
      `${kindJa(ev.kind)}${ev.place ? " / " + ev.place : ""} [${ev.status}]`,
      ev.hits?.length ? "興味の言葉: " + ev.hits.map((hit) => hit.word).join("・") : null,
      categoriesOf(ev.title).length ? "カテゴリー: " + categoriesOf(ev.title).join("・") : null,
      ev.colorId > 0 ? "色: " + (GCAL_COLORS[ev.colorId] || {}).name : null,
    ].filter(Boolean).join("\n");
    list.appendChild(li);
  }
  updateSelectionUi();
}

async function render() {
  const settings = await loadSettings();
  const { store } = await chrome.storage.local.get("store");
  const raw = [];
  Object.values(store || {}).forEach((part) => raw.push(...(part.events || [])));
  const allRaw = uniqueEvents(raw);
  const all = allRaw.map((ev) => decorateEvent(ev, settings));
  const { kept, dropped } = applyFilter(allRaw, settings);
  const knownIds = new Set(all.map((ev) => ev.id));
  for (const id of [...selectedIds]) if (!knownIds.has(id)) selectedIds.delete(id);
  model = { settings, all, recommended: kept, visible: [], dropped };
  renderLegend(settings);
  renderCategories(settings);
  renderTopics();
  renderResults();
}

function showStatus(status) {
  const st = status || {};
  const el = $("status");
  el.classList.toggle("error", st.phase === "error");
  const when = st.lastSync ? ` (前回同期 ${new Date(st.lastSync).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })})` : "";
  el.textContent = (st.message || "") + when;
}

function setBusy(button, busy) {
  button.disabled = busy || (button.id === "addSelected" && selectedIds.size === 0);
}

$("searchBox").addEventListener("submit", (event) => event.preventDefault());
$("keyword").addEventListener("input", renderResults);
$("clearSearch").onclick = () => { $("keyword").value = ""; $("keyword").focus(); renderResults(); };
$("filterToggle").onclick = () => {
  const panel = $("filterPanel");
  panel.hidden = !panel.hidden;
  $("filterToggle").setAttribute("aria-expanded", String(!panel.hidden));
  updateFilterButton();
};
for (const id of ["dateFrom", "dateTo", "place", "category", "topic"]) $(id).addEventListener("input", renderResults);
for (const input of document.querySelectorAll('input[name="weekday"], input[name="scope"]')) input.addEventListener("change", renderResults);
function foldConditions() {
  $("filterPanel").hidden = true;
  $("filterToggle").setAttribute("aria-expanded", "false");
  updateFilterButton();
}
// 「条件をたたむ」: 保存はせず閉じるだけ(一覧を広く見る)
$("foldConditions").onclick = foldConditions;
// 「条件を保存」: 場所・曜日・カテゴリーまで含めて今の条件を保存し、パネルを閉じる(次に開いた時も同じ条件で出る)
$("saveConditions").onclick = async () => {
  const ui = await settingsReady;
  await ui.saveNow();
  setTimeout(foldConditions, 700);
};
$("selectVisible").addEventListener("change", (event) => {
  for (const ev of model.visible) {
    if (event.target.checked) selectedIds.add(ev.id); else selectedIds.delete(ev.id);
  }
  renderResults();
});

// 地域・注目語などの保存される項目は「条件」パネルの中(2026-09-25 v0.4.1。別の設定画面は廃止)
const settingsReady = initSettings();
$("profileButton").onclick = pickProfileImage;
$("reload").onclick = async () => {
  setBusy($("reload"), true);
  showStatus({ phase: "read", message: "裏で読み直し中…(10〜20秒)" });
  const st = await chrome.runtime.sendMessage({ type: "OPEN_CALENDAR_TABS" });
  showStatus(st || { message: "応答なし" });
  setBusy($("reload"), false);
};
$("openGcal").onclick = () => chrome.runtime.sendMessage({ type: "OPEN_GCAL" });
$("openLibe").onclick = () => chrome.runtime.sendMessage({ type: "OPEN_LIBE" });
$("addSelected").onclick = async () => {
  setBusy($("addSelected"), true);
  showStatus({ phase: "sync", message: `選んだ${selectedIds.size}件を追加しています…` });
  const st = await chrome.runtime.sendMessage({ type: "SYNC_SELECTED", eventIds: [...selectedIds] });
  showStatus(st || { message: "応答なし" });
  setBusy($("addSelected"), false);
};

chrome.runtime.onMessage.addListener((msg) => { if (msg.type === "STATUS") showStatus(msg.status); });
chrome.storage.onChanged.addListener((changes) => {
  if (changes.store || changes.settings) render();
  if (changes.profileImage) applyProfileImage();
});

chrome.runtime.sendMessage({ type: "GET_STATUS" }).then(showStatus);
applyProfileImage();
// sidepanel.html?view=settings で開かれた時は条件パネルを先に開く
if (new URLSearchParams(location.search).get("view") === "settings") $("filterToggle").click();
// 保存しておいた「種類・注目語」「カテゴリー」は、選択肢ができてから戻す
settingsReady.then(async (ui) => {
  await render();
  const s = ui.saved();
  for (const [id, value] of [["category", s.filterCategory], ["topic", s.topic]]) {
    if (value && [...$(id).options].some((o) => o.value === value)) $(id).value = value;
  }
  renderResults();
});

return { selectedIds, getModel: () => model, showStatus };
})();

// ---------- drafts.js ----------
// Tampermonkey 版の仕上げ: Googleカレンダーは OAuth をやめ、予定ごとに Google の作成画面(下書きURL)を開く。
// 保存は利用者が Google の画面で押す。チェックした予定はパネルの中に並べ、1件ずつボタンで開く(ポップアップブロック対策)。
// 開閉ボタンの数字・Tampermonkey のメニュー・初回の使い方もここ。
const { loadSettings: __loadSettings, applyFilter: __applyFilter } = __mod_filter;
const __sp = __mod_sidepanel;
const __pad = (n) => String(n).padStart(2, '0');
const __WD = ['日', '月', '火', '水', '木', '金', '土'];

function __nextDay(ymd) {
  // 日本時間のPCでも1日ずれないよう UTC で数える(拡張の gcal.js と同じ)
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
const __compact = (ymd) => ymd.replace(/-/g, '');
const __hm = (t) => t.replace(':', '') + '00';

// 予定のページ。行の中にリンクがあればそれ、無ければイベントカレンダー(拡張の説明欄と同じ)
function __eventUrl(ev) {
  if (ev.link && /^https:\/\/libecity\.com\//.test(ev.link)) return ev.link;
  if (/-meet_up_/.test(ev.id || '')) return 'https://libecity.com/mypage/event_calendar?event=' + encodeURIComponent(ev.id);
  return 'https://libecity.com/mypage/event_calendar' + (ev.kind === 'online' ? '?tab=online' : '');
}

// Google カレンダーの作成画面(下書き)の URL。時刻は日本時間(ctz=Asia/Tokyo)で渡すので、PC の時間帯に左右されない
function __draftUrl(ev) {
  let dates;
  if (ev.start && ev.end) {
    let endDate = ev.endDate || ev.startDate;
    if (endDate === ev.startDate && ev.end <= ev.start) endDate = __nextDay(ev.startDate); // 23:00〜01:00 のように日をまたぐ
    dates = `${__compact(ev.startDate)}T${__hm(ev.start)}/${__compact(endDate)}T${__hm(ev.end)}`;
  } else {
    dates = `${__compact(ev.startDate)}/${__compact(__nextDay(ev.endDate || ev.startDate))}`; // 終日
  }
  const kindJa = ev.kind === 'online' ? 'オンライン' : ev.kind === 'office' ? 'オフィス開催' : 'オフライン';
  const hitWords = (ev.hits || []).map((h) => h.word);
  const details = [
    `リベシティのイベント: ${__eventUrl(ev)}`,
    '',
    `${kindJa}${ev.place ? ' / ' + ev.place : ''}`,
    ev.status ? `状態: ${ev.status}` : null,
    hitWords.length ? `興味の言葉: ${hitWords.join('・')}` : null,
    '',
    '(リベ イベント フィルターから作成)',
  ].filter((x) => x !== null).join('\n');
  const p = new URLSearchParams({ action: 'TEMPLATE', text: (ev.star ? '★ ' : '') + (ev.title || ''), dates, details, ctz: 'Asia/Tokyo' });
  if (ev.place) p.set('location', ev.place);
  return 'https://calendar.google.com/calendar/render?' + p.toString();
}

function __whenText(ev) {
  const d = new Date(ev.startDate + 'T00:00:00');
  const day = `${d.getMonth() + 1}/${d.getDate()} ${__WD[d.getDay()]}`;
  return ev.start ? `${day} ${ev.start}〜${ev.end || ''}` : `${day} 終日`;
}
const __esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function __openDraft(ev) {
  GM_openInTab(__draftUrl(ev), { active: true });
}

// 緑のボタン: 1件ならそのまま作成画面を開く。2件以上はパネルに並べて、1件ずつ開いてもらう
function __showDrafts() {
  const model = __sp.getModel();
  const byId = new Map((model.all || []).map((ev) => [ev.id, ev]));
  const events = [...__sp.selectedIds].map((id) => byId.get(id)).filter(Boolean)
    .sort((a, b) => (a.startDate + (a.start || '')).localeCompare(b.startDate + (b.start || '')));
  if (!events.length) return __sp.showStatus({ phase: 'idle', message: '選んだ予定が一覧から見つかりませんでした。「更新」を押してください' });
  if (events.length === 1) {
    __openDraft(events[0]);
    return __sp.showStatus({ phase: 'done', message: 'Googleカレンダーの作成画面を開きました。中身を確かめて「保存」を押してください' });
  }
  const box = __shadow.getElementById('lefDrafts');
  box.innerHTML = `<header><h2>📅 Googleカレンダーに入れる(${events.length}件)</h2>
    <p>「開く」を押すと、日時と場所を書き込んだ作成画面が新しいタブで開きます。中身を確かめて「保存」を押してください。1件ずつ開きます。</p></header>
    <ol>${events.map((ev, i) => `<li><div style="min-width:0"><div class="when">${__esc(__whenText(ev))}</div><div class="what" title="${__esc(ev.title)}">${__esc(ev.title)}</div></div>
      <button type="button" class="open" data-i="${i}">開く</button></li>`).join('')}</ol>
    <footer><button type="button" id="lefDraftsClose">閉じる</button></footer>`;
  box.querySelectorAll('.open').forEach((b) => {
    b.onclick = () => {
      __openDraft(events[+b.dataset.i]);
      b.classList.add('done');
      b.textContent = '✓ 開いた';
    };
  });
  box.querySelector('#lefDraftsClose').onclick = () => { box.hidden = true; };
  box.hidden = false;
}
__shadow.getElementById('addSelected').onclick = __showDrafts; // 拡張の「Googleカレンダーへ追加(OAuth)」をここで置き換える

// 開閉ボタンの数字 = 条件に合う予定の数(拡張のアイコンの数字と同じ)
async function __updateBadge() {
  const settings = await __loadSettings();
  const raw = [];
  Object.values(GM_getValue('store') || {}).forEach((part) => raw.push(...(part.events || [])));
  const ids = new Set();
  const uniq = raw.filter((ev) => ev && ev.id && !ids.has(ev.id) && ids.add(ev.id));
  __badgeFn(uniq.length ? String(__applyFilter(uniq, settings).kept.length) : '');
}
__changeFns.push((changes) => { if (changes.store || changes.settings) __updateBadge(); });
__updateBadge();

__shadow.getElementById('lefClose').onclick = () => __setOpen(false);
__setOpen(__ui.open);
GM_registerMenuCommand('📅 イベント一覧を開く・閉じる', __togglePanel);
GM_registerMenuCommand('❓ 使い方を開く', () => GM_openInTab(__HOME, { active: true }));

// 入れて最初の1回だけ、使い方のページを開く
if (!GM_getValue('lefGuideShown')) {
  GM_setValue('lefGuideShown', true);
  GM_openInTab(__HOME, { active: true });
}

// 試験台から確かめるための入口(本物のリベシティでは使わない)
if (__TEST_ORIGIN !== null) window.__lefTest = { draftUrl: __draftUrl, eventUrl: __eventUrl, setOpen: __setOpen, shadow: __shadow };

})();
