// Мок-тест режима --scheduled: проверяет дедупликацию (маркер GitHub и стена
// группы), создание отложенного поста и файл-маркер.
// Запуск: node test-scheduled.js
const path = require('path');
const fs = require('fs');

let wallPostCalls = [];
let wallPostArgs = null;

// Время: "сегодня 19:00 МСК" в unix
const MSK = 3 * 60 * 60 * 1000;
const msk = new Date(Date.now() + MSK);
const today19 = Date.UTC(msk.getUTCFullYear(), msk.getUTCMonth(), msk.getUTCDate(), 16, 0, 0) / 1000;
const todayStr = new Date(Date.now() + MSK).toISOString().slice(0, 10);

// Сценарии поведения стены
let scenario = 'empty'; // 'empty' | 'postponed' | 'published'
// Сценарии маркера GitHub: true — артефакт есть, false — нет
let ghMarker = false;

const realFetch = global.fetch;

// Фиксируем «сейчас» = сегодня 14:15 МСК, чтобы тест был детерминированным
const FIXED_NOW = Date.UTC(msk.getUTCFullYear(), msk.getUTCMonth(), msk.getUTCDate(), 11, 15, 0);
Date.now = () => FIXED_NOW;

global.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes('api.github.com')) {
    // Список артефактов-маркеров posted-<дата>-bot<N>
    const wanted = u.match(/name=posted-(\d{4}-\d{2}-\d{2})-bot(\d+)/);
    if (!wanted) return realFetch(url, opts);
    const items = ghMarker ? [{ id: 1, name: decodeURIComponent(wanted[0].slice(5)), expired: false }] : [];
    return { ok: true, json: async () => ({ total_count: items.length, artifacts: items }) };
  }
  if (u.includes('wall.get')) {
    const body = new URLSearchParams(opts.body);
    if (body.get('filter') === 'postponed') {
      const items = scenario === 'postponed'
        ? [{ id: 100, publish_date: today19 }] : [];
      return { ok: true, json: async () => ({ response: { items } }) };
    }
    // filter=owner
    const items = scenario === 'published'
      ? [{ id: 200, date: today19 - 3600, text: '☀️ Погода на завтра — Москва... #погода #Москва' }]
      : [];
    return { ok: true, json: async () => ({ response: { items } }) };
  }
  if (u.includes('wall.post')) {
    wallPostArgs = Object.fromEntries(new URLSearchParams(opts.body));
    wallPostCalls.push(wallPostArgs);
    return { ok: true, json: async () => ({ response: { post_id: 999 } }) };
  }
  if (u.includes('geocoding-api')) {
    return { ok: true, json: async () => ({ results: [{ name: 'Москва', latitude: 55.75, longitude: 37.62 }] }) };
  }
  if (u.includes('api.open-meteo.com')) {
    const day = new Date(FIXED_NOW + 86400000).toISOString().slice(0, 10);
    const today = new Date(FIXED_NOW).toISOString().slice(0, 10);
    return {
      ok: true,
      json: async () => ({
        daily: {
          time: [today, day],
          weather_code: [0, 2],
          temperature_2m_max: [5, 6],
          temperature_2m_min: [-1, 0],
          precipitation_sum: [0, 0.5],
          precipitation_probability_max: [10, 40],
          wind_speed_10m_max: [3, 4],
          sunrise: [day + 'T08:00', day + 'T08:00'],
          sunset: [day + 'T17:00', day + 'T17:00'],
        },
      }),
    };
  }
  return realFetch(url, opts);
};

process.env.VK_TOKEN = 'dummy';
process.env.VK_GROUP_ID = '12345';
process.env.CITY = 'Москва';
process.env.LAT = '55.75';
process.env.LON = '37.62';
process.env.POST_TIME = '19:00';
process.argv = [process.argv[0], path.join(__dirname, 'index.js'), '--scheduled'];

function line() { console.log('\n=== СЦЕНАРИЙ: ' + scenario.toUpperCase() + ' ==='); }

async function run() {
  // пересоздаём модуль для чистого состояния
  delete require.cache[require.resolve('./index.js')];
  line();
  await require('./index.js');
}

(async () => {
  // 1. Стена пуста, маркера нет → должен создать ОТЛОЖЕННЫЙ пост на 19:00
  scenario = 'empty';
  ghMarker = false;
  await run();
  if (wallPostCalls.length !== 1) throw new Error('FAIL: ожидался 1 вызов wall.post, было ' + wallPostCalls.length);
  if (!wallPostArgs.publish_date) throw new Error('FAIL: publish_date не передан');
  if (Math.abs(Number(wallPostArgs.publish_date) - today19) > 60) throw new Error('FAIL: publish_date != 19:00 МСК');
  console.log('>>> OK: создан отложенный пост на 19:00 МСК (publish_date=' + wallPostArgs.publish_date + ')');

  // 2. Уже есть отложенный пост на сегодня → запуск должен пропуститься
  wallPostCalls = [];
  scenario = 'postponed';
  await run();
  if (wallPostCalls.length !== 0) throw new Error('FAIL: wall.post вызван при существующей отложке!');
  console.log('>>> OK: дубли не созданы (найдена отложка, wall.post не вызывался)');

  // 3. Сегодняшний пост уже опубликован → запуск должен пропуститься
  wallPostCalls = [];
  scenario = 'published';
  await run();
  if (wallPostCalls.length !== 0) throw new Error('FAIL: wall.post вызван при вышедшем посте!');
  console.log('>>> OK: дубли не созданы (пост уже опубликован, wall.post не вызывался)');

  // 4. Маркер GitHub: артефакт posted-<сегодня>-bot1 есть → пропуск без публикации
  wallPostCalls = [];
  scenario = 'empty';
  process.env.GH_TOKEN = 'test-token';
  process.env.GH_REPO = 'octo/repo';
  ghMarker = true;
  await run();
  if (wallPostCalls.length !== 0) throw new Error('FAIL: wall.post вызван при артефакте-маркере!');
  console.log('>>> OK: дубли не созданы (маркер GitHub, wall.post не вызывался)');

  // 5. Маркера нет, GH настроен → пост публикуется и создаётся файл-маркер
  wallPostCalls = [];
  ghMarker = false;
  const markerFile = path.join(__dirname, 'markers', 'posted-bot1.txt');
  await run();
  if (wallPostCalls.length !== 1) throw new Error('FAIL: ожидался 1 вызов wall.post, было ' + wallPostCalls.length);
  if (!fs.existsSync(markerFile)) throw new Error('FAIL: файл-маркер markers/posted-bot1.txt не создан');
  const markerVal = fs.readFileSync(markerFile, 'utf8').trim();
  if (markerVal !== todayStr) throw new Error(`FAIL: в файле-маркере «${markerVal}», ожидалось «${todayStr}»`);
  console.log(`>>> OK: пост опубликован, файл-маркер создан (${markerVal})`);

  // 6. --force пропускает проверку дублей даже при маркере
  wallPostCalls = [];
  ghMarker = true;
  process.argv = [process.argv[0], path.join(__dirname, 'index.js'), '--scheduled', '--force'];
  await run();
  if (wallPostCalls.length !== 1) throw new Error('FAIL: --force не обошёл проверку дублей!');
  console.log('>>> OK: --force публикует даже при маркере');

  // уборка
  fs.rmSync(path.join(__dirname, 'markers'), { recursive: true, force: true });
  delete process.env.GH_TOKEN;
  delete process.env.GH_REPO;

  console.log('\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ ✅');
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
