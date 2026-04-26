require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');

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

const SYSTEM_PROMPT = `
你是「EST168」的客服人員，名字叫做 Linda（琳達）。
無論客人叫你 Linda、LINDA、linda、琳達，都要認得出來。
請用親切、專業的繁體中文回覆，適時使用表情符號。
只回答與課程相關的問題。

【目前課程】
課程名稱：主力透視鏡
主講人：阿嘉師
課程類型：線上直播課
課程日期：2026/5/30
課程時間：13:00~16:00
課程地點：專屬線上社團教室
影片回放：全程可回放觀看
社團關閉：2026/7/30
定價：NT$3,999
早鳥價：NT$2,899（省 $1,100）
贈品：股票挖土機 3.0（90天，價值 NT$800）

【課程內容】
- 核心指標解析：判讀資金動向
- 致富軌跡策略：轉折抄底、熱門籌碼、吃主力豆腐
- 實戰操作流程：動態部位管理

【適合對象】
- 追高殺低的迷航散戶
- 工作繁忙需要自動化篩選的人
- 想從感覺交易轉型量化邏輯的人

【遇到無法回答的問題】
請說：「感謝您的詢問！這個問題我幫您轉給專人處理 😊」
`;

app.post('/webhook', line.middleware(lineConfig), async (req, res) => {
  const events = req.body.events;
  await Promise.all(events.map(handleEvent));
  res.json({ status: 'ok' });
});

async function handleEvent(event) {
  if (event.type !== 'message') return;
  if (event.message.type !== 'text' && event.message.type !== 'image') return;

  let messageContent;

  if (event.message.type === 'text') {
    messageContent = [{ type: 'text', text: event.message.text }];
  } else if (event.message.type === 'image') {
    const imgResponse = await axios.get(
      `https://api-data.line.me/v2/bot/message/${event.message.id}/content`,
      {
        headers: { Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` },
        responseType: 'arraybuffer'
      }
    );
    const imageData = Buffer.from(imgResponse.data).toString('base64');
    messageContent = [
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/jpeg',
          data: imageData
        }
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

  await client.replyMessage({
    replyToken: event.replyToken,
    messages: [{ type: 'text', text: replyText }],
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Linda Bot 啟動成功！Port: ${PORT}`);
});