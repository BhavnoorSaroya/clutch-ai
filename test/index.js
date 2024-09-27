require('dotenv').config();
const { App, ExpressReceiver } = require('@slack/bolt');
const axios = require('axios');
const moment = require('moment-timezone');
const express = require('express');
const bodyParser = require('body-parser');
const { handleTrelloWebhook, fetchAndSaveDefaultLists } = require('./webhookHandler');

const { saveBoard, getLastEditedBoard, saveListToBoard, syncBoards, saveCardToList, updateCardInJson, findCardInBoard } = require('./dataAccess');

// Initialize an ExpressReceiver
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  endpoints: '/slack/events',
  processBeforeResponse: true  // Set true for AWS Lambda or similar environments
});

// Initialize Slack app with the custom receiver
const slackApp = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver, // Use the ExpressReceiver
  socketMode: false, // Change to true if using socket mode
  appToken: process.env.SLACK_APP_TOKEN, // Required for socket mode
});

// Access the Express app from the receiver
const app = receiver.app;
app.use(bodyParser.json());

// Add this near your other route definitions
app.get('/webhook', (req, res) => {
  res.status(200).send('Webhook endpoint is working');
});

// Trello webhook endpoint
app.post('/webhook', (req, res) => {
  const event = req.body;
  console.log('Received Trello webhook event:', JSON.stringify(event, null, 2));

  // Here you can handle different types of Trello events
  if (event.action && event.action.type) {
    handleTrelloWebhook(event.action);
  }
  res.status(200).send('OK');
});

// Trello API Key and Token from env
const trelloKey = process.env.TRELLO_API_KEY;
const trelloToken = process.env.TRELLO_API_TOKEN;

slackApp.message(/sync boards/i, async ({ message, say }) => {
  try {
    await say('Syncing boards, lists, and cards from Trello...');

    // Call the syncBoards function from dataAccess.js to sync everything
    await syncBoards();

    await say('Boards, lists, and cards have been successfully synced!');
  } catch (error) {
    console.error('Error syncing boards:', error);
    await say('An error occurred while syncing the boards. Please try again.');
  }
});

async function createTrelloWebhook(boardId) {
  try {
    const callbackURL = `https://stud-becoming-rodent.ngrok-free.app/webhook`;  // Your ngrok URL
    const response = await axios.post(`https://api.trello.com/1/webhooks/?key=${trelloKey}&token=${trelloToken}`, {
      description: "Webhook for Trello Board",
      callbackURL,
      idModel: boardId // The ID of the Trello board to watch
    });
    console.log('Webhook created:', response.data);
    return response.data;
  } catch (error) {
    if (error.response) {
      console.error('Error creating Trello webhook:', error.response.data); // Only log Trello's error response data
    } else {
      console.error('Error creating Trello webhook:', error.message); // Other Axios or network issues
    }
    throw error;
  }
}


// Function to create a Trello board and record default lists
async function createTrelloBoard(boardName) {
  try {
    // Create the board
    const boardResponse = await axios.post(`https://api.trello.com/1/boards/?name=${encodeURIComponent(boardName)}&key=${trelloKey}&token=${trelloToken}`);
    const newBoard = boardResponse.data;
    console.log('Board created successfully:', newBoard.id);

    saveBoard(newBoard.id, boardName);
    console.log('Board saved to JSON:', newBoard.id);

    await fetchAndSaveDefaultLists(newBoard.id);
    console.log('Default lists fetched and saved');

    // Create webhook
    try {
      await createTrelloWebhook(newBoard.id);
    } catch (webhookError) {
      console.error('Error creating webhook:', webhookError.message);
      // Continue execution even if webhook creation fails
    }
    return newBoard;

  } catch (error) {
    console.error('Error creating Trello board:');
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', error.response.data);
    } else if (error.request) {
      console.error('No response received:', error.request);
    } else {
      console.error('Error message:', error.message);
    }
    throw error;
  }
}

// Function to create a list on a Trello board
async function createTrelloList(listName) {
  const board = getLastEditedBoard();
  console.log('Current board for list creation:', board);
  if (!board) {
    throw new Error('No board found to add the list. Please create a board first.');
  }

  try {
    const response = await axios.post(`https://api.trello.com/1/lists?name=${listName}&idBoard=${board.id}&key=${trelloKey}&token=${trelloToken}`);
    saveListToBoard(board.id, listName, response.data.id);
    console.log(`List created and saved: ${response.data.id} - ${listName} on board ${board.id}`);
    return response.data;
  } catch (error) {
    console.error('Error creating Trello list:', error);
    throw error;
  }
}

// Listen for messages that match the pattern "create board <board-name>"
slackApp.message(/create board (.*)/, async ({ message, say, context }) => {
  const boardName = context.matches[1].trim();
  await say(`You said: ${message.text}. I will create the board: ${boardName}`);

  try {
    const newBoard = await createTrelloBoard(boardName);
    await say(`New Trello board created: ${newBoard.name}!\nURL: ${newBoard.url}`);
  } catch (error) {
    await say('Sorry, there was an error creating the board.');
    console.error(error);
  }
});

// Listen for messages that match the pattern "create list <list-name>"
slackApp.message(/create list (.*)/, async ({ message, say, context }) => {
  const listName = context.matches[1].trim();

  try {
    const newList = await createTrelloList(listName);
    await say(`New Trello list created: ${newList.name} on the board!`);
  } catch (error) {
    await say('Sorry, there was an error creating the list.');
    console.error(error);
  }
});

// Function to create a Trello card on a list
async function createTrelloCard(cardName, listId) {
  try {
    const response = await axios.post(`https://api.trello.com/1/cards?name=${cardName}&idList=${listId}&key=${trelloKey}&token=${trelloToken}`);
    return response.data;
  } catch (error) {
    console.error('Error creating Trello card:', error);
    throw error;
  }
}

// Create a middleware to handle conversation flow
const conversationState = {};

// Listen for "create card <card-name>" message
slackApp.message(/create card (.*)/, async ({ message, say, context }) => {
  const cardName = context.matches[1].trim();

  // Fetch the current board and lists
  const board = getLastEditedBoard();
  if (!board) {
    await say('No board found to add the card. Please create a board first.');
    return;
  }

  // List the available lists and prompt the user to select one
  const listNames = board.lists.map((list, index) => `${index + 1}. ${list.name}`).join('\n');
  await say(`Please choose a list to add the card to:\n${listNames}`);

  // Store the card name and board state in the conversation state for the user
  conversationState[message.user] = { cardName, board, step: 'chooseList' };
});

// Listen for the user choosing a list (capturing next user input)
slackApp.message(/choose (\d+)/, async ({ message, say, context }) => {
  const userState = conversationState[message.user];
  if (!userState || userState.step !== 'chooseList') {
    await say('Please start by creating a card with the "create card <name>" command.');
    return;
  }

  const listIndex = parseInt(context.matches[1].trim()) - 1;
  const { cardName, board } = userState;

  if (listIndex < 0 || listIndex >= board.lists.length) {
    await say('Invalid list selection. Please try again.');
    return;
  }

  const list = board.lists[listIndex];

  // Create the card in the chosen list
  try {
    const newCard = await createTrelloCard(cardName, list.id);

    // Save the card to the list in the JSON file
    saveCardToList(board.id, list.id, {
      id: newCard.id,
      name: newCard.name,
      dueDate: null,
      startDate: null,
      checklists: [],
      description: ""
    });

    await say(`New Trello card created: ${newCard.name} in the list: ${list.name}`);

    // End the conversation after card creation
    delete conversationState[message.user];

    // In the card creation handler, replace the existing prompt with:
    await promptForMoreEdits(say, message.user, newCard.id);

  } catch (error) {
    await say('Sorry, there was an error creating the card.');
    console.error(error);
  }
});

async function promptForMoreEdits(say, userId, cardId) {
  await say('Would you like to add more details to the card? (Reply with "yes" or "no")');
  conversationState[userId] = { cardId: cardId, step: 'editCardPrompt' };
}

// Listen for user response on whether they want to edit the card
slackApp.message(/(yes|no)/, async ({ message, say, context }) => {
  const userState = conversationState[message.user];

  if (!userState || userState.step !== 'editCardPrompt') {
    return; // Ignore unrelated messages
  }

  const input = message.text.trim().toLowerCase();

  if (input === 'yes') {
    await say('What would you like to add?\n1. Due Date\n2. Start Date\n3. Checklist\n4. Description');
    conversationState[message.user].step = 'chooseEditOption';
  } else {
    await say('Okay! Card editing is complete.');
    delete conversationState[message.user];
  }
});

// Listen for the next step when editing a card
slackApp.message(/(1|2|3|4)/, async ({ message, say, context }) => {
  const userState = conversationState[message.user];

  if (!userState || userState.step !== 'chooseEditOption') {
    return; // Ignore unrelated messages
  }

  const cardId = userState.cardId;

  switch (context.matches[1]) {
    case '1': // Due Date
      await say('Please provide the due date in the format YYYY-MM-DD. You can optionally include a time (24-hour format) after the date, separated by a space. For example: "2023-05-15" or "2023-05-15 14:30". If no time is specified, it will default to 23:59.');
      conversationState[message.user].step = 'dueDate';
      break;
    case '2': // Start Date
      await say('Please provide the start date by typing "start" followed by the date in the format YYYY-MM-DD. For example: "start 2023-05-15".');
      conversationState[message.user].step = 'startDate';
      break;
    case '3': // Checklist
      await say('Please provide the checklist in the following format: checklist "Checklist Name, Item 1, Item 2, Item 3"');
      conversationState[message.user].step = 'checklist';
      break;
    case '4': // Description
      await say('Please provide a description for the card. Type "description" followed by your text.');
      conversationState[message.user].step = 'description';
      break;
  }
});

// Function to add a due date to a Trello card with time set to 11:59 PM in user's local time zone
async function addDueDateToCard(cardId, dateTimeString, userTimeZone = 'America/Los_Angeles') {
  try {
    let dueDateWithTime;
    if (dateTimeString.includes(' ')) {
      // If time is provided
      dueDateWithTime = moment.tz(dateTimeString, 'YYYY-MM-DD HH:mm', userTimeZone);
    } else {
      // If only date is provided, set time to 23:59
      dueDateWithTime = moment.tz(dateTimeString + ' 23:59', 'YYYY-MM-DD HH:mm', userTimeZone);
    }

    // Convert the due date to UTC before sending to Trello
    const adjustedDueDate = dueDateWithTime.utc().format();

    // Send the adjusted due date to Trello
    const response = await axios.put(`https://api.trello.com/1/cards/${cardId}?due=${adjustedDueDate}&key=${trelloKey}&token=${trelloToken}`);

    // Find the board and list that contain the card
    const board = getLastEditedBoard();
    if (board) {
      for (const list of board.lists) {
        const card = list.cards.find(c => c.id === cardId);
        if (card) {
          // Update the card in the JSON file
          updateCardInJson(board.id, list.id, {
            ...card,
            dueDate: dueDateWithTime.format() // Store the full date and time
          });
          break;
        }
      }
    }

    return response.data;
  } catch (error) {
    console.error('Error adding due date to card:', error);
    throw error;
  }
}

// Listen for user input to provide the due date
slackApp.message(/^\d{4}-\d{2}-\d{2}(\s\d{2}:\d{2})?$/, async ({ message, say, context }) => {
  const userState = conversationState[message.user];

  if (!userState || userState.step !== 'dueDate') {
    await say('No active card modification in progress or wrong step. Please create or choose a card.');
    return;
  }

  const { cardId } = userState;
  const dateTimeString = message.text.trim();

  // Add the due date to the Trello card
  try {
    const updatedCard = await addDueDateToCard(cardId, dateTimeString);
    await say(`Due date added to the card: ${updatedCard.name}, Due: ${dateTimeString}`);
    await promptForMoreEdits(say, message.user, cardId);
  } catch (error) {
    await say('There was an error adding the due date. Please try again.');
  }
});

async function addStartDateToCard(cardId, dateString, userTimeZone = 'America/Los_Angeles') {
  try {
    // Parse the date string in the user's time zone
    const startDate = moment.tz(dateString, 'YYYY-MM-DD', userTimeZone);

    if (!startDate.isValid()) {
      throw new Error('Invalid date format');
    }

    const adjustedStartDate = startDate.utc().format();

    // Send the adjusted start date to Trello
    const response = await axios.put(`https://api.trello.com/1/cards/${cardId}?start=${adjustedStartDate}&key=${trelloKey}&token=${trelloToken}`);

    // Find the board and list that contain the card
    const board = getLastEditedBoard();
    if (board) {
      for (const list of board.lists) {
        const card = list.cards.find(c => c.id === cardId);
        if (card) {
          // Update the card in the JSON file
          updateCardInJson(board.id, list.id, {
            ...card,
            startDate: startDate.format('YYYY-MM-DD') // Store the date in user's time zone
          });
          break;
        }
      }
    }

    return response.data;
  } catch (error) {
    console.error('Error adding start date to card:', error);
    throw error;
  }
}

slackApp.message(/^start\s+(\d{4}-\d{2}-\d{2})$/, async ({ message, say, context }) => {
  const userState = conversationState[message.user];

  if (!userState || userState.step !== 'startDate') {
    await say('No active card modification in progress or wrong step. Please create or choose a card.');
    return;
  }

  const { cardId } = userState;
  const dateString = context.matches[1].trim();

  // Add the start date to the Trello card
  try {
    const updatedCard = await addStartDateToCard(cardId, dateString, 'America/Los_Angeles');
    await say(`Start date added to the card: ${updatedCard.name}, Start: ${dateString}`);
    await promptForMoreEdits(say, message.user, cardId);
  } catch (error) {
    if (error.message === 'Invalid date format') {
      await say('Invalid date format. Please use YYYY-MM-DD.');
    } else {
      await say('There was an error adding the start date. Please try again.');
    }
  }
});

async function addChecklistToCard(cardId, checklistName, items) {
  try {
    // First, create a new checklist in Trello
    const checklistResponse = await axios.post(`https://api.trello.com/1/checklists?idCard=${cardId}&name=${encodeURIComponent(checklistName)}&key=${trelloKey}&token=${trelloToken}`);
    const newChecklist = checklistResponse.data;

    // Then, add items to the checklist
    const checkItems = [];
    for (const item of items) {
      const itemResponse = await axios.post(`https://api.trello.com/1/checklists/${newChecklist.id}/checkItems?name=${encodeURIComponent(item)}&key=${trelloKey}&token=${trelloToken}`);
      checkItems.push(itemResponse.data);
    }

    // Update the card in our JSON file
    const board = getLastEditedBoard();
    if (board) {
      for (const list of board.lists) {
        const card = list.cards.find(c => c.id === cardId);
        if (card) {
          if (!card.checklists) {
            card.checklists = [];
          }
          const existingChecklistIndex = card.checklists.findIndex(cl => cl.id === newChecklist.id);
          if (existingChecklistIndex === -1) {
            card.checklists.push({
              id: newChecklist.id,
              name: checklistName,
              items: checkItems.map(item => ({
                id: item.id,
                name: item.name,
                state: item.state
              }))
            });
          } else {
            // Update existing checklist
            card.checklists[existingChecklistIndex] = {
              ...card.checklists[existingChecklistIndex],
              name: checklistName,
              items: checkItems.map(item => ({
                id: item.id,
                name: item.name,
                state: item.state
              }))
            };
          }
          updateCardInJson(board.id, list.id, card);
          break;
        }
      }
    }

    return newChecklist;
  } catch (error) {
    console.error('Error adding checklist to card:', error);
    throw error;
  }
}


slackApp.message(/^checklist\s+(.+)$/, async ({ message, say, context }) => {
  const userState = conversationState[message.user];

  if (!userState || userState.step !== 'checklist') {
    await say('No active card modification in progress or wrong step. Please create or choose a card.');
    return;
  }

  const { cardId } = userState;
  const checklistInput = context.matches[1].trim();

  // Split the input into checklist name and items
  let checklistName, items;

  if (checklistInput.includes('"')) {
    // If there are quotes, assume the first quoted part is the checklist name
    const matches = checklistInput.match(/"([^"]+)"\s*,?\s*(.+)/);
    if (matches) {
      checklistName = matches[1].trim();
      items = matches[2].split(',').map(item => item.trim());
    }
  } else {
    // If no quotes, assume the first comma-separated item is the checklist name
    [checklistName, ...items] = checklistInput.split(',').map(item => item.trim());
  }

  if (!checklistName || items.length === 0) {
    await say('Please provide a checklist name and at least one item. Format: "Checklist Name", Item 1, Item 2, ...');
    return;
  }

  try {
    const newChecklist = await addChecklistToCard(cardId, checklistName, items);
    await say(`Checklist "${checklistName}" added to the card with ${items.length} item(s): ${items.join(', ')}`);
    await promptForMoreEdits(say, message.user, cardId);
  } catch (error) {
    console.error('Error adding checklist:', error);
    await say('There was an error adding the checklist. Please try again.');
  }
});

async function addDescriptionToCard(cardId, description) {
  try {
    const response = await axios.put(`https://api.trello.com/1/cards/${cardId}?key=${trelloKey}&token=${trelloToken}`, {
      desc: description
    });

    const updatedCard = response.data;

    // Update the card in our JSON file
    const board = getLastEditedBoard();
    if (board) {
      for (const list of board.lists) {
        const card = list.cards.find(c => c.id === cardId);
        if (card) {
          card.description = description;
          updateCardInJson(board.id, list.id, card);
          break;
        }
      }
    }

    return updatedCard;
  } catch (error) {
    console.error('Error adding description to card:', error);
    throw error;
  }
}

slackApp.message(/^description\s+(.+)$/, async ({ message, say, context }) => {
  const userState = conversationState[message.user];

  if (!userState || userState.step !== 'description') {
    await say('No active card modification in progress or wrong step. Please create or choose a card.');
    return;
  }

  const { cardId } = userState;
  const description = context.matches[1].trim();

  try {
    const updatedCard = await addDescriptionToCard(cardId, description);
    await say(`Description added to the card: "${description.substring(0, 50)}${description.length > 50 ? '...' : ''}"`);
    await promptForMoreEdits(say, message.user, cardId);
  } catch (error) {
    console.error('Error adding description:', error);
    await say('There was an error adding the description. Please try again.');
  }
});

// Start the Slack app and listen for events
(async () => {
  await slackApp.start(process.env.PORT || 3000); // Use slackApp to start the Slack bot
  console.log('⚡️ Bolt app is running!');

  try {
    const result = await slackApp.client.chat.postMessage({
      token: process.env.SLACK_BOT_TOKEN,
      channel: 'slack-bot-testing',
      text: 'Start Planning With @Clutch!',
      icon_emoji: ':robot_face:'
    });
    console.log(result);
  } catch (error) {
    console.error(error);
  }
})();
