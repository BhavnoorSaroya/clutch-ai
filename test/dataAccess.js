const fs = require('fs');
const axios = require('axios');
const path = './boards.json';

const trelloKey = process.env.TRELLO_API_KEY;
const trelloToken = process.env.TRELLO_API_TOKEN;

// Load the data from the JSON file
function loadData() {
    if (fs.existsSync(path)) {
        const rawData = fs.readFileSync(path);
        return JSON.parse(rawData);
    }
    return { lastEditedBoardId: null, boards: {} }; // If the file doesn't exist, return an empty structure
}

// Save the data back to the JSON file
function saveData(data) {
    fs.writeFileSync(path, JSON.stringify(data, null, 2)); // Pretty-print JSON
}

function saveBoard(boardId, boardName, closed = false) {
    try {
        const data = loadData();
        data.boards[boardId] = { id: boardId, name: boardName, closed: closed, lists: [] };
        data.lastEditedBoardId = boardId;
        saveData(data);
        console.log(`Board saved successfully: ${boardId} - ${boardName} (Closed: ${closed})`);
    } catch (error) {
        console.error(`Error saving board: ${boardId}`, error);
    }
}

// Get the most recently edited board
function getLastEditedBoard() {
    const data = loadData();
    const lastBoardId = data.lastEditedBoardId;
    if (lastBoardId && data.boards[lastBoardId]) {
        return data.boards[lastBoardId];
    }
    return null; // If no board has been edited yet
}

function updateBoardInJson(boardId, updates) {
    const data = loadData();
    if (data.boards[boardId]) {
        data.boards[boardId] = { ...data.boards[boardId], ...updates };
        saveData(data);
        console.log(`Board updated in JSON: ${boardId}`, updates);
    } else {
        console.error(`Board not found in JSON: ${boardId}`);
    }
}

function deleteBoardInJson(boardId) {
    const data = loadData();
    if (data.boards[boardId]) {
        delete data.boards[boardId];
        if (data.lastEditedBoardId === boardId) {
            data.lastEditedBoardId = null;
        }
        saveData(data);
        console.log(`Board deleted from JSON: ${boardId}`);
    } else {
        console.log(`Board not found in JSON: ${boardId}`);
    }
}

async function refreshBoardData(boardId) {
    try {
        const boardResponse = await axios.get(`https://api.trello.com/1/boards/${boardId}?lists=open&cards=visible&key=${trelloKey}&token=${trelloToken}`);
        const board = boardResponse.data;

        saveBoard(board.id, board.name, board.closed);

        // Clear existing lists and cards
        const data = loadData();
        data.boards[boardId].lists = [];
        saveData(data);

        // Add current lists and cards
        for (const list of board.lists) {
            saveListToBoard(boardId, list.name, list.id);
            for (const card of list.cards) {
                saveCardToList(boardId, list.id, {
                    id: card.id,
                    name: card.name,
                    dueDate: card.due,
                    description: card.desc
                });
            }
        }

        console.log(`Board data refreshed: ${boardId}`);
    } catch (error) {
        console.error(`Error refreshing board data: ${boardId}`, error);
    }
}

// Sync the JSON file by removing deleted boards and syncing lists and cards
async function syncBoards() {
    const data = loadData();
    const boardIds = Object.keys(data.boards);

    for (const boardId of boardIds) {
        // Sync lists for the board
        await syncLists(boardId);

        // Sync cards for each list in the board
        const board = data.boards[boardId];
        for (const list of board.lists) {
            await syncCards(boardId, list.id);
        }
    }

    saveData(data); // Save updated data back to JSON
}


function saveListToBoard(boardId, listName, listId) {
    const data = loadData();
    const board = data.boards[boardId];

    if (!board) {
        console.error(`Board with ID ${boardId} not found.`);
        return;
    }

    const existingList = board.lists.find(list => list.id === listId);
    if (!existingList) {
        board.lists.push({ id: listId, name: listName, cards: [] });
        console.log(`Added list ${listName} (${listId}) to board ${boardId}`);
        saveData(data);
    } else {
        console.log(`List ${listName} (${listId}) already exists on board ${boardId}`);
    }
}

function updateListInJson(boardId, listId, updates) {
    const data = loadData();
    const board = data.boards[boardId];
    if (!board) {
        console.error(`Board with ID ${boardId} not found.`);
        return;
    }
    const listIndex = board.lists.findIndex(list => list.id === listId);
    if (listIndex !== -1) {
        board.lists[listIndex] = { ...board.lists[listIndex], ...updates };
        saveData(data);
        console.log(`List updated: ${listId} in board ${boardId}`, updates);
    } else {
        console.error(`List with ID ${listId} not found in board ${boardId}.`);
    }
}


function deleteListInJson(boardId, listId) {
    const data = loadData();  // Load existing JSON data
    const board = data.boards[boardId];  // Get the board

    // Remove the list from the board
    board.lists = board.lists.filter(list => list.id !== listId);
    console.log(`Deleted list ${listId} from board ${boardId}`);

    saveData(data);  // Save changes back to the JSON file
}

// Sync lists within a board
async function syncLists(boardId) {
    try {
        const response = await axios.get(`https://api.trello.com/1/boards/${boardId}/lists?key=${trelloKey}&token=${trelloToken}`);
        const trelloLists = response.data;
        const data = loadData();
        const board = data.boards[boardId];

        // Update or remove lists based on Trello data
        board.lists = board.lists.filter(list => trelloLists.find(trelloList => trelloList.id === list.id));
        trelloLists.forEach(trelloList => {
            if (!board.lists.find(list => list.id === trelloList.id)) {
                // Add new lists from Trello
                board.lists.push({
                    id: trelloList.id,
                    name: trelloList.name,
                    cards: [] // Placeholder for cards, which will be synced separately
                });
            }
        });

        saveData(data); // Save the updated lists to the JSON file
    } catch (error) {
        console.error('Error syncing lists:', error);
        throw error;
    }
}

function saveCardToList(boardId, listId, card) {
    const data = loadData();  // Load existing JSON data
    const board = data.boards[boardId];  // Get the board

    if (!board) {
        console.error(`Board with ID ${boardId} not found.`);
        return;
    }

    const list = board.lists.find(list => list.id === listId);
    if (!list) {
        console.error(`List with ID ${listId} not found on board ${boardId}.`);
        return;
    }

    // Ensure that the card doesn't already exist
    const existingCard = list.cards.find(c => c.id === card.id);
    if (!existingCard) {
        list.cards.push({
            ...card,  // Add the new card
            archived: card.archived || false  // Default to false if not provided
        });
        console.log(`Added card ${card.id} to list ${listId}`);
        saveData(data);  // Save changes back to the JSON file
    } else {
        console.log(`Card ${card.id} already exists in list ${listId}`);
    }
}

function updateCardInJson(boardId, listId, updatedCard) {
    const data = loadData();
    const board = data.boards[boardId];
    if (!board) {
        console.error(`Board with ID ${boardId} not found.`);
        return;
    }

    const targetList = board.lists.find(l => l.id === listId);
    if (!targetList) {
        console.error(`List with ID ${listId} not found in board ${boardId}.`);
        return;
    }

    const cardIndex = targetList.cards.findIndex(c => c.id === updatedCard.id);


    if (cardIndex !== -1 && targetList) {
        // Merge the existing card data with the updated data
        targetList.cards[cardIndex] = {
            ...targetList.cards[cardIndex],
            ...updatedCard,
            // Ensure these fields are always present
            startDate: targetList.cards[cardIndex].startDate || null,
            checklists: typeof updatedCard.checklists === 'function'
                ? updatedCard.checklists(targetList.cards[cardIndex].checklists || [])
                : (updatedCard.checklists || targetList.cards[cardIndex].checklists || []),
            dueDate: 'dueDate' in updatedCard ? updatedCard.dueDate : targetList.cards[cardIndex].dueDate,
            dueDateComplete: 'dueDateComplete' in updatedCard ? updatedCard.dueDateComplete : targetList.cards[cardIndex].dueDateComplete,
            startDate: 'startDate' in updatedCard ? updatedCard.startDate : targetList.cards[cardIndex].startDate,
            archived: 'archived' in updatedCard ? updatedCard.archived : targetList.cards[cardIndex].archived || false,
            description: updatedCard.description || targetList.cards[cardIndex].description || ""
        };
        saveData(data);
        console.log(`Updated card ${updatedCard.id} in list ${targetList.id}`);
    } else {
        console.error(`Card with ID ${updatedCard.id} not found in list ${listId} of board ${boardId}.`);
    }
}

function deleteCardInJson(boardId, cardId, listId) {
    const data = loadData();  // Load existing JSON data
    const board = data.boards[boardId];  // Get the board
    const list = board.lists.find(list => list.id === listId);

    if (list) {
        list.cards = list.cards.filter(card => card.id !== cardId);
        console.log(`Deleted card ${cardId} from list ${listId}`);
        saveData(data);  // Save changes back to the JSON file
    } else {
        console.error(`List ${listId} not found on board ${boardId}`);
    }
}

// Helper function to move a card from one list to another in the JSON
function moveCardInJson(boardId, cardId, oldListId, newListId) {
    const data = loadData();
    const board = data.boards[boardId];

    if (!board) {
        console.error(`Board with ID ${boardId} not found.`);
        return;
    }

    const oldList = board.lists.find(list => list.id === oldListId);
    const newList = board.lists.find(list => list.id === newListId);

    if (!oldList || !newList) {
        console.error(`One or both lists not found. Old list: ${oldListId}, New list: ${newListId}`);
        return;
    }

    const cardIndex = oldList.cards.findIndex(card => card.id === cardId);
    if (cardIndex === -1) {
        console.error(`Card ${cardId} not found in list ${oldListId}`);
        return;
    }

    const [movedCard] = oldList.cards.splice(cardIndex, 1);
    newList.cards.push(movedCard);

    console.log(`Moved card ${cardId} from list ${oldListId} to ${newListId}`);
    saveData(data);
}

async function syncCards(boardId, listId) {
    try {
        const response = await axios.get(`https://api.trello.com/1/lists/${listId}/cards?key=${trelloKey}&token=${trelloToken}`);
        const trelloCards = response.data;  // Trello cards from API

        const data = loadData();  // Load existing JSON data
        const board = data.boards[boardId];
        const list = board.lists.find(list => list.id === listId);

        // Ensure the list exists before syncing cards
        if (!list) {
            console.log(`List with ID ${listId} not found in the JSON file for board ${boardId}.`);
            return;
        }

        // Ensure list.cards exists before trying to sync
        if (!list.cards) {
            list.cards = [];
        }

        // Loop over Trello cards and check if they exist in the JSON
        trelloCards.forEach(trelloCard => {
            let existingCard = findCardInBoard(board, trelloCard.id);

            if (existingCard) {
                if (existingCard.listId !== listId) {
                    // The card has moved to a new list
                    moveCardInJson(data, boardId, existingCard, trelloCard, existingCard.listId, listId);
                } else {
                    // Update card details (e.g., due date)
                    existingCard.dueDate = trelloCard.due || null;
                    existingCard.archived = trelloCard.closed || false;
                }
            } else {
                // If the card does not exist in the JSON, add it to the current list
                const newCard = {
                    id: trelloCard.id,
                    name: trelloCard.name,
                    dueDate: trelloCard.due || null,
                    startDate: null,  // Placeholder for future use
                    checklists: [],  // Placeholder for future use
                    archived: trelloCard.closed || false
                };
                list.cards.push(newCard);
            }
        });

        saveData(data);  // Save updated cards to the JSON file
    } catch (error) {
        console.error('Error syncing cards:', error);
        throw error;
    }
}

// Helper function to find a card in any list on the board
function findCardInBoard(board, cardId) {
    for (const list of board.lists) {
        const card = list.cards.find(card => card.id === cardId);
        if (card) {
            return { ...card, listId: list.id };
        }
    }
    return null;
}

module.exports = {
    saveBoard,
    getLastEditedBoard,
    saveListToBoard,
    syncBoards,
    syncCards,
    saveCardToList,
    findCardInBoard,
    moveCardInJson,
    deleteCardInJson,
    deleteListInJson,
    deleteBoardInJson,
    updateBoardInJson,
    updateListInJson,
    updateCardInJson,
    refreshBoardData
};
