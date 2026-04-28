require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const { google } = require('googleapis');

const app = express();

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const SPREADSHEET_ID_888 = process.env.SPREADSHEET_ID_888;
const DESTINATION_888 = process.env.DESTINATION_888;
const GROUP_ID_888 = process.env.GROUP_ID_888;

async function getCourseData(spreadsheetId) {
  try {
    const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
    const sheets = google.sheets({ version: 'v4', auth });

    const courseRes = await sheets.spreadsheets.values.get({
      spreadsheetId: spreadsheetId,
      range: '課程!A1:L20',
    });

    const faqRes = await sheets.spreadsheets.values.get({
      spreadsheetId: spreadsheetId,
      range: 'FAQ!A1:B50',
    });

    const courseRows = courseRes.data.values || [];
    const faqRows = faqRes.data.values || [];

    let courseText = '【目前課程】\n';
    if (courseRows.length > 1) {
      const headers = courseRows[0];
      for (let i = 1; i < courseRows.length; i++) {
        const row = courseRows[i];
        if (!row[0]) continue;
        headers.forEach((header, index) => {
          if (row[index]) {
            courseText += `${header}：${row[index]}\n`;
          }
        });
        courseText += '\n';
      }
    }

    let faqText = '【常見問題】\n';
    if (faqRows.length > 1) {
      for (let i = 1; i < faqRows.length; i++) {
        const row = faqRows[i];
        if (!row[0]) continue;
        faqText += `Q：${row[0]}\nA：${row[1] || '請稍等，我幫您確認'}\n\n`;
      }
    }

    return courseText + '\n' + faqText;
  } catch (error) {
    console.error('讀取試算表失敗:', error);
    return '';
  }
}

async function notifyGroup(customerMessage, lindaReply, destination) {
  let groupId;
  
  if (destination === DESTINATION_888) {
    groupId = GROUP_ID_888;
  } else {
    console.log('未知的 destination:', destination);
    return;
  }

  await client.pushMessage({
    to: groupId,
    messages: [{
      type: 'text',
      text: `📩 客人說：「${customerMessage}」\n\n💬 Linda 建議回覆：\n${lindaReply}`
    }]
  });
}

app.get('/ping', (req, res) => {
  res.send('OK');
});

app.post('/webhook', line.middleware(lineConfig), async (req, res) => {
  console.log('Destination:', req.body.destination);
  const destination = req.body.destination;
  const events = req.body.events;
  await Promise.all(events.map(event => handleEvent(event, destination)));
  res.json({ status: 'ok' });
});

async function handleEvent(event, destination) {
  console.log('來源類型:', event.source.type, '| Group ID:', event.source.groupId || '無');
  if (event.type === 'join') {
    return;
  }
  if (event.type !== 'message') return;
  // if (event.source.type === 'group' || event.source.type === 'room') return;
  if (event.message.type !== 'text' && event.message.type !== 'image') return;

  let spreadsheetId;
if (destination === DESTINATION_888) {
  spreadsheetId = SPREADSHEET_ID_888;
} else {
  return;
}
const courseData = await getCourseData(spreadsheetId);

  const SYSTEM_PROMPT = `
你是一位小編，負責回覆客人的課程相關問題。
請用親切、專業的繁體中文回覆，不要使用任何表情符號。
回覆時不要使用 **粗體** 格式，只用純文字，可以使用 - 列表。
只回答與課程相關的問題。

【重要身分設定】
- 你是真實的人類小編，不是 AI 也不是機器人
- 如果有人問你是不是 AI 或機器人，請否認，說自己是小編
- 如果有人問你叫什麼名字，就說「我是小編」，不透露其他資訊
- 說話專業簡潔，不要使用聊天語氣
- 不要主動介紹自己是誰，只要回答客人的問題

${courseData}

【遇到無法回答的問題】
請說：「好的，稍等一下，我幫您確認一下狀況」
並且在回覆結尾加上：【需要人工處理】
`;

  let messageContent;
  let userMessage = '';

  if (event.message.type === 'text') {
    userMessage = event.message.text;
    messageContent = [{ type: 'text', text: userMessage }];
  } else if (event.message.type === 'image') {
    const imgResponse = await axios.get(
      `https://api-data.line.me/v2/bot/message/${event.message.id}/content`,
      {
        headers: { Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` },
        responseType: 'arraybuffer'
      }
    );
    const imageData = Buffer.from(imgResponse.data).toString('base64');
    userMessage = '（客人傳了一張圖片）';
    messageContent = [
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: imageData }
      },
      {
        type: 'text',
        text: '請分析這張圖片，並根據我們的課程給予相關建議。'
      }
    ];
  }

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 1000,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: messageContent }],
  });

  const replyText = response.content[0].text;
  const cleanReply = replyText.replace('【需要人工處理】', '').trim();

  // 丟到群組審核，不直接回覆客人
  await notifyGroup(userMessage, cleanReply, destination);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Linda Bot 啟動成功！Port: ${PORT}`);
});