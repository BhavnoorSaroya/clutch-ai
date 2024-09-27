const axios = require('axios');

const {
    saveBoard,
    saveListToBoard,
    saveCardToList,
    moveCardInJson,
    deleteCardInJson,
    deleteListInJson,
    deleteBoardInJson,
    updateBoardInJson,
    updateListInJson,
    updateCardInJson,
    refreshBoardData,
    getLastEditedBoard
} = require('./dataAccess');


const trelloKey = process.env.TRELLO_API_KEY;
const trelloToken = process.env.TRELLO_API_TOKEN;

async function handleTrelloWebhook(action) {
    console.log('Received action:', JSON.stringify(action, null, 2));

    // Specific logging for checklist-related actions
    if (action.type.includes('Checklist')) {
        console.log('Checklist action details:');
        console.log('Action Type:', action.type);
        console.log('Action Data:', JSON.stringify(action.data, null, 2));
        console.log('Board ID:', action.data.board?.id);
        console.log('Card ID:', action.data.card?.id);
        console.log('List ID:', action.data.list?.id);
        console.log('Checklist ID:', action.data.checklist?.id);
    }

    const boardId = action.data.board.id;

    switch (action.type) {
        case 'createBoard':
            saveBoard(boardId, action.data.board.name);
            console.log(`Board created: ${boardId} - ${action.data.board.name}`);
            try {
                await fetchAndSaveDefaultLists(boardId);
            } catch (error) {
                console.error('Failed to fetch and save default lists:', error.message);
                // Optionally, you could implement some retry logic here
            }
            break;

        case 'updateBoard':
            updateBoardInJson(boardId, {
                name: action.data.board.name,
                closed: action.data.board.closed,
            });
            console.log(`Board updated: ${boardId} - ${action.data.board.name}`);
            break;

        case 'closeBoard':
            updateBoardInJson(boardId, { closed: action.type === 'closeBoard' });
            console.log(`Board ${action.type === 'closeBoard' ? 'closed' : 'reopened'}: ${boardId}`);
            break;

        case 'reopenBoard':
            updateBoardInJson(boardId, { closed: false });
            await refreshBoardData(boardId);
            console.log(`Board reopened and data refreshed: ${boardId}`);
            break;

        case 'deleteBoard':
        case 'removeFromOrganizationBoard':
            deleteBoardInJson(boardId);
            await deleteWebhook(boardId)
            console.log(`Board deleted: ${boardId}`);
            break;

        case 'createList':
            saveListToBoard(boardId, action.data.list.name, action.data.list.id);
            console.log(`List created: ${action.data.list.id} - ${action.data.list.name} on board ${boardId}`);
            break;

        case 'updateList':
            updateListInJson(boardId, action.data.list.id, {
                name: action.data.list.name,
                closed: action.data.list.closed,
            });
            console.log(`List updated: ${action.data.list.id} - ${action.data.list.name}`);
            break;

        case 'moveListFromBoard':
        case 'deleteList':
            deleteListInJson(boardId, action.data.list.id);
            console.log(`List deleted: ${action.data.list.id} from board ${boardId}`);
            break;

        case 'createCard':
            const listId = action.data.list.id;
            const newCard = {
                id: action.data.card.id,
                name: action.data.card.name,
                dueDate: null,
                startDate: null,
                checklists: [],
                description: ""
            };
            saveCardToList(boardId, listId, newCard);
            console.log(`Card created: ${action.data.card.id} - ${action.data.card.name} in list ${listId}`);
            break;

        case 'updateCard':
            let updatedCard = {
                id: action.data.card.id,
                name: action.data.card.name,
                description: action.data.card.desc || "",
                archived: action.data.card.closed || false
            };

            // Only include dueDate if it's present in the action data
            if ('due' in action.data.card) {
                updatedCard.dueDate = action.data.card.due;
            }

            // Include dueDateComplete if it's present in the action data
            if ('dueComplete' in action.data.card) {
                updatedCard.dueDateComplete = action.data.card.dueComplete;
            }

            // Include startDate if it's present in the action data
            if ('start' in action.data.card) {
                updatedCard.startDate = action.data.card.start;
            }

            // Handle description updates
            if ('desc' in action.data.card) {
                updatedCard.description = action.data.card.desc;
            }

            if (action.data.listAfter && action.data.listBefore) {
                // Card was moved between lists
                moveCardInJson(
                    boardId,
                    action.data.card.id,
                    action.data.listBefore.id,
                    action.data.listAfter.id
                );
                console.log(`Card ${action.data.card.id} moved from list ${action.data.listBefore.id} to ${action.data.listAfter.id}`);
            } else if (action.data.list) {
                // Card was updated within the same list
                updateCardInJson(boardId, action.data.list.id, updatedCard);
                console.log(`Card updated: ${updatedCard.id} - ${updatedCard.name}`);
            }
            break;


        case 'archiveCard':
        case 'unarchiveCard':
            updateCardInJson(boardId, action.data.list.id, {
                id: action.data.card.id,
                archived: action.type === 'archiveCard'
            });
            console.log(`Card ${action.data.card.id} ${action.type === 'archiveCard' ? 'archived' : 'unarchived'}`);
            break;

        case 'deleteCard':
            deleteCardInJson(boardId, action.data.card.id, action.data.list.id);
            console.log(`Card deleted: ${action.data.card.id} from list ${action.data.list.id}`);
            break;

        case 'addChecklistToCard':
            handleAddChecklistToCard(boardId, action.data);
            break;

        case 'updateCheckItemStateOnCard':
            handleCheckItemChange(boardId, action.data, 'updateCheckItem');
            break;

        case 'removeChecklistFromCard':
            handleRemoveChecklistFromCard(boardId, action.data);
            break;

        case 'updateChecklist':
            handleUpdateChecklist(boardId, action.data);
            break;

        case 'createCheckItem':
        case 'updateCheckItem':
        case 'deleteCheckItem':
        case 'updatedCheckItemStateOnCard':
            handleCheckItemChange(boardId, action.data, action.type);
            break;

        // Add more cases for other Trello events like `updateCard`, `createList`, etc.
        default:
            console.log('Unhandled webhook event:', action.type);
    }
}

async function fetchAndSaveDefaultLists(boardId) {
    try {
        const response = await axios.get(`https://api.trello.com/1/boards/${boardId}/lists?key=${trelloKey}&token=${trelloToken}`);

        if (!response.data || !Array.isArray(response.data)) {
            throw new Error('Invalid response data from Trello API');
        }

        const lists = response.data;

        if (lists.length === 0) {
            console.warn(`No default lists found for board ${boardId}`);
            return;
        }

        for (const list of lists) {
            if (!list.id || !list.name) {
                console.warn(`Invalid list data received: ${JSON.stringify(list)}`);
                continue;
            }

            try {
                saveListToBoard(boardId, list.name, list.id);
                console.log(`Default list added: ${list.name} (${list.id}) to board ${boardId}`);
            } catch (saveError) {
                console.error(`Error saving list ${list.name} (${list.id}) to board ${boardId}:`, saveError.message);
            }
        }
    } catch (error) {
        if (error.response) {
            // The request was made and the server responded with a status code
            // that falls out of the range of 2xx
            console.error('Error fetching default lists - Server responded with error:', error.response.status, error.response.data);
        } else if (error.request) {
            // The request was made but no response was received
            console.error('Error fetching default lists - No response received:', error.request);
        } else {
            // Something happened in setting up the request that triggered an Error
            console.error('Error fetching default lists:', error.message);
        }
        throw new Error(`Failed to fetch and save default lists for board ${boardId}: ${error.message}`);
    }
}

async function deleteWebhook(boardId) {
    try {
        const webhooks = await axios.get(`https://api.trello.com/1/tokens/${trelloToken}/webhooks?key=${trelloKey}`);
        const webhook = webhooks.data.find(hook => hook.idModel === boardId);

        if (webhook) {
            await axios.delete(`https://api.trello.com/1/webhooks/${webhook.id}?key=${trelloKey}&token=${trelloToken}`);
            console.log(`Webhook deleted for board ${boardId}`);
        } else {
            console.log(`No webhook found for board ${boardId}`);
        }
    } catch (error) {
        console.error(`Error deleting webhook for board ${boardId}:`, error);
    }
}

function handleAddChecklistToCard(boardId, data) {
    const { card, checklist } = data;
    const board = getLastEditedBoard();
    if (board) {
        for (const list of board.lists) {
            const cardToUpdate = list.cards.find(c => c.id === card.id);
            if (cardToUpdate) {
                if (!cardToUpdate.checklists) {
                    cardToUpdate.checklists = [];
                }
                // Check if the checklist already exists
                const existingChecklistIndex = cardToUpdate.checklists.findIndex(cl => cl.id === checklist.id);
                if (existingChecklistIndex === -1) {
                    cardToUpdate.checklists.push({
                        id: checklist.id,
                        name: checklist.name,
                        items: []
                    });
                } else {
                    // Update existing checklist
                    cardToUpdate.checklists[existingChecklistIndex] = {
                        ...cardToUpdate.checklists[existingChecklistIndex],
                        name: checklist.name
                    };
                }
                updateCardInJson(boardId, list.id, cardToUpdate);
                console.log(`Checklist ${checklist.name} added or updated on card ${card.id}`);
                break;
            }
        }
    }
}

function handleRemoveChecklistFromCard(boardId, data) {
    const { card, checklist } = data;
    const board = getLastEditedBoard();
    if (board) {
        for (const list of board.lists) {
            const cardToUpdate = list.cards.find(c => c.id === card.id);
            if (cardToUpdate && cardToUpdate.checklists) {
                cardToUpdate.checklists = cardToUpdate.checklists.filter(cl => cl.id !== checklist.id);
                updateCardInJson(boardId, list.id, cardToUpdate);
                console.log(`Checklist ${checklist.name} removed from card ${card.id}`);
                break;
            }
        }
    }
}

function handleUpdateChecklist(boardId, data) {
    const { card, checklist } = data;
    const board = getLastEditedBoard();
    if (board) {
        for (const list of board.lists) {
            const cardToUpdate = list.cards.find(c => c.id === card.id);
            if (cardToUpdate && cardToUpdate.checklists) {
                const checklistToUpdate = cardToUpdate.checklists.find(cl => cl.id === checklist.id);
                if (checklistToUpdate) {
                    checklistToUpdate.name = checklist.name;
                    updateCardInJson(boardId, list.id, cardToUpdate);
                    console.log(`Checklist ${checklist.name} updated on card ${card.id}`);
                    break;
                }
            }
        }
    }
}

function handleCheckItemChange(boardId, data, actionType) {
    const { card, checklist, checkItem } = data;
    const board = getLastEditedBoard();
    if (board) {
        for (const list of board.lists) {
            const cardToUpdate = list.cards.find(c => c.id === card.id);
            if (cardToUpdate && cardToUpdate.checklists) {
                const checklistToUpdate = cardToUpdate.checklists.find(cl => cl.id === checklist.id);
                if (checklistToUpdate) {
                    switch (actionType) {
                        case 'createCheckItem':
                            // Check if the item already exists
                            const existingItem = checklistToUpdate.items.find(item => item.id === checkItem.id);
                            if (!existingItem) {
                                checklistToUpdate.items.push({
                                    id: checkItem.id,
                                    name: checkItem.name,
                                    state: checkItem.state
                                });
                            }
                            break;
                        case 'updateCheckItem':
                        case 'updateCheckItemStateOnCard':
                            const itemToUpdate = checklistToUpdate.items.find(item => item.id === checkItem.id);
                            if (itemToUpdate) {
                                itemToUpdate.name = checkItem.name;
                                itemToUpdate.state = checkItem.state;
                            }
                            break;
                        case 'deleteCheckItem':
                            checklistToUpdate.items = checklistToUpdate.items.filter(item => item.id !== checkItem.id);
                            break;
                    }
                    updateCardInJson(boardId, list.id, cardToUpdate);
                    console.log(`CheckItem ${actionType} on checklist ${checklist.name} of card ${card.id}`);
                    break;
                }
            }
        }
    }
}

module.exports = { handleTrelloWebhook, fetchAndSaveDefaultLists };
