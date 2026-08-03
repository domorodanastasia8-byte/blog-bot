// ============================================================
//  Дневник блогера — сервер + бот
//  Всё в одном файле, чтобы было проще разобраться.
// ============================================================

const express = require('express');
const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');

const TOKEN = process.env.BOT_TOKEN;       // токен от @BotFather (задаётся в Secrets/Environment)
const APP_URL = process.env.APP_URL;       // публичный https-адрес сервера, без / в конце
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

if (!TOKEN) {
  console.error('⚠️  BOT_TOKEN не задан! Добавь его в переменные окружения.');
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- простая "база данных" в одном JSON-файле ----------
function loadDB() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}
function saveDB(db) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}
function uid() {
  return 'id' + Date.now() + Math.floor(Math.random() * 10000);
}
function addToList(key, item) {
  const db = loadDB();
  let arr = [];
  try { arr = db[key] ? JSON.parse(db[key]) : []; } catch (e) { arr = []; }
  arr.push(item);
  db[key] = JSON.stringify(arr);
  saveDB(db);
}

// ---------- API для мини-приложения (повторяет window.storage) ----------
app.get('/api/storage/:key', (req, res) => {
  const db = loadDB();
  if (!(req.params.key in db)) return res.status(404).json({ error: 'not found' });
  res.json({ value: db[req.params.key] });
});
app.post('/api/storage/:key', (req, res) => {
  const db = loadDB();
  db[req.params.key] = req.body.value;
  saveDB(db);
  res.json({ value: db[req.params.key] });
});
app.delete('/api/storage/:key', (req, res) => {
  const db = loadDB();
  delete db[req.params.key];
  saveDB(db);
  res.json({ deleted: true });
});
app.get('/api/storage-list', (req, res) => {
  const db = loadDB();
  const prefix = req.query.prefix || '';
  res.json({ keys: Object.keys(db).filter(k => k.startsWith(prefix)) });
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

bot.on('message', (msg) => {
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

  if (matched === 'tasks') {
    addToList('checklist-items', { id: uid(), text: rest, done: false, date: '', priority: 'Средний', starred: false });
    reply(msg.chat.id, `✅ Добавила в чек-лист: «${rest}»`);
  } else if (matched === 'ideas') {
    addToList('ideas', { id: uid(), text: rest, rubric: '' });
    reply(msg.chat.id, `💡 Добавила в идеи: «${rest}»`);
  } else if (matched === 'plan') {
    addToList('content-items', {
      id: uid(), topic: rest, rubric: '', platforms: [], date: '', shootDate: '',
      script: '', shootList: [], filmed: false, edited: false, published: false
    });
    reply(msg.chat.id, `🗓 Добавила в контент-план: «${rest}»`);
  } else if (matched === 'shoot') {
    const today = new Date().toISOString().slice(0, 10);
    addToList('content-items', {
      id: uid(), topic: rest, rubric: '', platforms: [], date: '', shootDate: today,
      script: '', shootList: [{ id: uid(), type: 'Видео', desc: rest, done: false }],
      filmed: false, edited: false, published: false
    });
    reply(msg.chat.id, `🎥 Добавила в съёмочный план: «${rest}»`);
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
