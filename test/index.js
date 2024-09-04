const { App } = require('@slack/bolt');
const axios = require('axios');

const app = new App({
  token: 'xoxb-7598424542562-7672800772035-8bwVKsNPNWo0QhfqzCJ43JbT', // Replace with your actual bot token
  signingSecret: '3b783c6aa9225b9d8fd2fcb6275925c2'
});

app.event('app_home_opened', async ({ event, say }) => {
  await say(`Welcome to Clutch, <@${event.user}>!`);
});

(async () => {
  await app.start(process.env.PORT || 3000);
  console.log('⚡️ Bolt app is running!');

  try {
    const result = await app.client.chat.postMessage({
      token: app.token,
      channel: 'slack-bot-testing',
      text: 'Start Planning With @Clutch!',
      icon_emoji: ':smiley:'
    });
    console.log(result);
  } catch (error) {
    console.error(error);
  }
})();
