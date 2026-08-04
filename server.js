// ============================================================
//  Дневник блогера — сервер + бот
//  Всё в одном файле, чтобы было проще разобраться.
// ============================================================

const express = require('express');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');

const TOKEN = process.env.BOT_TOKEN;       // токен от @BotFather (задаётся в Secrets/Environment)
const APP_URL = process.env.APP_URL;       // публичный https-адрес сервера, без / в конце
const PORT = process.env.PORT || 3000;
const UPSTASH_URL = process.env.UPSTASH_URL;     // REST URL из консоли Upstash
const UPSTASH_TOKEN = process.env.UPSTASH_TOKEN; // REST TOKEN из консоли Upstash

if (!TOKEN) {
  console.error('⚠️  BOT_TOKEN не задан! Добавь его в переменные окружения.');
}
if (!UPSTASH_URL || !UPSTASH_TOKEN) {
  console.error('⚠️  UPSTASH_URL / UPSTASH_TOKEN не заданы! Данные не будут сохраняться.');
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- постоянное хранилище (Upstash Redis, переживает перезапуски) ----------
async function upstashGet(key) {
  const res = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
  });
  const data = await res.json();
  return data.result; // строка или null, если ключа нет
}
async function upstashSet(key, value) {
  await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    body: value
  });
}
async function upstashDel(key) {
  await fetch(`${UPSTASH_URL}/del/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
  });
}
function uid() {
  return 'id' + Date.now() + Math.floor(Math.random() * 10000);
}
async function addToList(key, item) {
  let arr = [];
  try {
    const raw = await upstashGet(key);
    arr = raw ? JSON.parse(raw) : [];
  } catch (e) { arr = []; }
  arr.push(item);
  await upstashSet(key, JSON.stringify(arr));
}

// ---------- API для мини-приложения (повторяет window.storage) ----------
app.get('/api/storage/:key', async (req, res) => {
  try {
    const value = await upstashGet(req.params.key);
    if (value === null || value === undefined) return res.status(404).json({ error: 'not found' });
    res.json({ value });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/storage/:key', async (req, res) => {
  try {
    await upstashSet(req.params.key, req.body.value);
    res.json({ value: req.body.value });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/storage/:key', async (req, res) => {
  try {
    await upstashDel(req.params.key);
    res.json({ deleted: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ---------- Telegram-бот (режим webhook — лучше дружит с бесплатным хостингом) ----------
const bot = new TelegramBot(TOKEN);

app.post(`/bot${TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

function reply(chatId, text) {
  bot.sendMessage(chatId, text);
}

bot.onText(/^\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    'Привет! Я твой помощник по блогу 🌸\n\n' +
      'Просто напиши сообщение, начиная с одного из слов:\n' +
      '• «Задачи ...» — добавлю в чек-лист\n' +
      '• «Идея ...» — добавлю в идеи\n' +
      '• «План ...» — добавлю в контент-план\n' +
      '• «Съемка ...» — добавлю в съёмочный план\n\n' +
      'Например: Задачи оформить инстаграм',
    {
      reply_markup: {
        inline_keyboard: [[{ text: '📋 Открыть приложение', web_app: { url: APP_URL } }]]
      }
    }
  );
});

bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/start')) return;
  const text = msg.text.trim();
  const norm = text.toLowerCase().replace(/ё/g, 'е');
  let matched = null;
  let rest = text;

  if (/^задач[аи]/.test(norm)) { matched = 'tasks'; rest = text.replace(/^задач[аи]/i, ''); }
  else if (/^иде[яи]/.test(norm)) { matched = 'ideas'; rest = text.replace(/^иде[яи]/i, ''); }
  else if (/^контент[\s-]?план/.test(norm)) { matched = 'plan'; rest = text.replace(/^контент[\s-]?план/i, ''); }
  else if (/^план/.test(norm)) { matched = 'plan'; rest = text.replace(/^план/i, ''); }
  else if (/^съемочны[йя][\s-]?план/.test(norm)) { matched = 'shoot'; rest = text.replace(/^съемочны[йя][\s-]?план/i, ''); }
  else if (/^съемк[аи]/.test(norm)) { matched = 'shoot'; rest = text.replace(/^съемк[аи]/i, ''); }

  if (!matched) {
    reply(msg.chat.id, 'Не поняла 🙈 Начни сообщение со слова: Задачи / Идея / План / Съемка');
    return;
  }

  rest = rest.replace(/^[\s:\-—]+/, '').trim();
  if (!rest) {
    reply(msg.chat.id, 'А текст? Например: «Задачи купить лампу»');
    return;
  }

  try {
    if (matched === 'tasks') {
      await addToList('checklist-items', { id: uid(), text: rest, done: false, date: '', priority: 'Средний', starred: false });
      reply(msg.chat.id, `✅ Добавила в чек-лист: «${rest}»`);
    } else if (matched === 'ideas') {
      await addToList('ideas', { id: uid(), text: rest, rubric: '' });
      reply(msg.chat.id, `💡 Добавила в идеи: «${rest}»`);
    } else if (matched === 'plan') {
      await addToList('content-items', {
        id: uid(), topic: rest, rubric: '', platforms: [], date: '', shootDate: '',
        script: '', shootList: [], filmed: false, edited: false, published: false
      });
      reply(msg.chat.id, `🗓 Добавила в контент-план: «${rest}»`);
    } else if (matched === 'shoot') {
      const today = new Date().toISOString().slice(0, 10);
      await addToList('content-items', {
        id: uid(), topic: rest, rubric: '', platforms: [], date: '', shootDate: today,
        script: '', shootList: [{ id: uid(), type: 'Видео', desc: rest, done: false }],
        filmed: false, edited: false, published: false
      });
      reply(msg.chat.id, `🎥 Добавила в съёмочный план: «${rest}»`);
    }
  } catch (e) {
    console.error('Ошибка сохранения:', e.message);
    reply(msg.chat.id, 'Упс, не получилось сохранить — попробуй ещё раз через минутку 🙏');
  }
});

app.listen(PORT, () => {
  console.log('Server running on port ' + PORT);
  if (TOKEN && APP_URL) {
    bot.setWebHook(`${APP_URL}/bot${TOKEN}`)
      .then(() => console.log('✅ Webhook установлен на ' + APP_URL))
      .catch(e => console.error('Ошибка установки webhook:', e.message));
  } else {
    console.log('⏳ APP_URL или BOT_TOKEN ещё не заданы — webhook не установлен.');
  }
});
