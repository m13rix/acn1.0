/**
 * Chat Storage Module
 * Stores chat metadata and messages in S3, with attachments stored separately
 * Falls back to local filesystem if S3 is not configured
 */

import {
  saveJson,
  loadJson,
  deleteJson,
  listObjects,
  saveAttachment,
  loadAttachment,
  deleteAttachments,
  generateAttachmentId
} from './s3Storage.js';

// S3 key prefixes
const CHATS_PREFIX = 'chats/data/';

/**
 * Generate a unique ID for chats
 */
function generateId() {
  return `chat_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Get S3 key for a chat
 */
function getChatKey(userId, chatId) {
  return `${CHATS_PREFIX}${userId}/${chatId}.json`;
}

/**
 * Extract attachment data from items and save separately
 * Returns items with attachments replaced by references
 */
async function processAttachmentsForSave(userId, chatId, items) {
  if (!items || !Array.isArray(items)) return items;
  
  const processedItems = [];
  
  for (const item of items) {
    if (item.attachments && item.attachments.length > 0) {
      const processedAttachments = [];
      
      for (const att of item.attachments) {
        // Check if already processed (has attachmentId but no base64)
        if (att.attachmentId && !att.base64) {
          processedAttachments.push(att);
          continue;
        }
        
        // Extract base64 data
        let base64Data = att.base64;
        if (!base64Data && att.dataUrl) {
          // Extract from dataUrl
          const match = att.dataUrl.match(/^data:[^;]+;base64,(.+)$/);
          if (match) {
            base64Data = match[1];
          }
        }
        
        if (base64Data) {
          // Save attachment to S3
          const attachmentId = generateAttachmentId();
          await saveAttachment(userId, chatId, attachmentId, base64Data, att.type);
          
          // Store reference instead of data
          processedAttachments.push({
            attachmentId,
            name: att.name,
            type: att.type,
            // Don't store base64 or dataUrl in chat JSON
          });
        } else {
          // No data, just keep metadata
          processedAttachments.push({
            name: att.name,
            type: att.type,
          });
        }
      }
      
      processedItems.push({
        ...item,
        attachments: processedAttachments
      });
    } else {
      processedItems.push(item);
    }
  }
  
  return processedItems;
}

/**
 * Load attachment data back into items
 */
async function hydrateAttachments(userId, chatId, items) {
  if (!items || !Array.isArray(items)) return items;
  
  const hydratedItems = [];
  
  for (const item of items) {
    if (item.attachments && item.attachments.length > 0) {
      const hydratedAttachments = [];
      
      for (const att of item.attachments) {
        if (att.attachmentId) {
          // Load from S3
          const loaded = await loadAttachment(userId, chatId, att.attachmentId);
          if (loaded) {
            hydratedAttachments.push({
              ...att,
              base64: loaded.data,
              dataUrl: `data:${att.type};base64,${loaded.data}`
            });
          } else {
            // Attachment not found, keep reference
            hydratedAttachments.push(att);
          }
        } else {
          hydratedAttachments.push(att);
        }
      }
      
      hydratedItems.push({
        ...item,
        attachments: hydratedAttachments
      });
    } else {
      hydratedItems.push(item);
    }
  }
  
  return hydratedItems;
}

/**
 * Get a preview string from chat items
 */
function getPreview(items) {
  if (!items || items.length === 0) return '';
  
  const firstUserMessage = items.find(item => item.role === 'user');
  if (firstUserMessage?.content) {
    return firstUserMessage.content.substring(0, 100);
  }
  return '';
}

/**
 * Get all chats (metadata only for listing)
 */
export async function getAllChats(userId) {
  try {
    const prefix = `${CHATS_PREFIX}${userId}/`;
    const keys = await listObjects(prefix);
    const chatFiles = keys.filter(k => k.endsWith('.json'));
    
    const chats = await Promise.all(
      chatFiles.map(async (key) => {
        try {
          const chat = await loadJson(key);
          if (!chat) return null;
          
          // Return only metadata for listing (no full messages/attachments)
          return {
            id: chat.id,
            title: chat.title,
            agentId: chat.agentId,
            createdAt: chat.createdAt,
            updatedAt: chat.updatedAt,
            messageCount: chat.items?.length || 0,
            preview: getPreview(chat.items)
          };
        } catch {
          return null;
        }
      })
    );
    
    // Filter nulls, sort by updatedAt descending
    return chats
      .filter(Boolean)
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  } catch (error) {
    console.error('Error reading chats:', error);
    return [];
  }
}

/**
 * Get a single chat by ID (full data with hydrated attachments)
 */
export async function getChatById(userId, chatId) {
  try {
    const chat = await loadJson(getChatKey(userId, chatId));
    if (!chat) return null;
    
    // Hydrate attachments with actual data
    chat.items = await hydrateAttachments(userId, chatId, chat.items);
    
    return chat;
  } catch (error) {
    console.error('Error loading chat:', error);
    return null;
  }
}

/**
 * Create a new chat
 */
export async function createChat(userId, data) {
  const now = new Date().toISOString();
  const chatId = generateId();
  
  // Process attachments if any
  const processedItems = await processAttachmentsForSave(userId, chatId, data.items || []);
  
  const chat = {
    id: chatId,
    userId,
    title: data.title || 'New Chat',
    agentId: data.agentId || null,
    items: processedItems,
    createdAt: now,
    updatedAt: now
  };
  
  await saveJson(getChatKey(userId, chatId), chat);
  
  return chat;
}

/**
 * Update an existing chat
 */
export async function updateChat(userId, chatId, updates) {
  const existing = await loadJson(getChatKey(userId, chatId));
  if (!existing) {
    throw new Error(`Chat not found: ${chatId}`);
  }
  
  // Process attachments if items are being updated
  let processedItems = existing.items;
  if (updates.items) {
    processedItems = await processAttachmentsForSave(userId, chatId, updates.items);
  }
  
  const updated = {
    ...existing,
    ...updates,
    items: processedItems,
    id: chatId, // Ensure ID cannot be changed
    updatedAt: new Date().toISOString()
  };
  
  await saveJson(getChatKey(userId, chatId), updated);
  
  return updated;
}

/**
 * Delete a chat and its attachments
 */
export async function deleteChat(userId, chatId) {
  try {
    // Delete attachments first
    await deleteAttachments(userId, chatId);
    
    // Delete chat JSON
    await deleteJson(getChatKey(userId, chatId));
    
    return true;
  } catch (error) {
    console.error('Error deleting chat:', error);
    return false;
  }
}

/**
 * Branch a chat from a specific message
 * Creates a new chat with history up to (and including) the specified message ID
 */
export async function branchChat(userId, originalChatId, messageId) {
  const originalChat = await getChatById(userId, originalChatId);
  if (!originalChat) {
    throw new Error(`Original chat not found: ${originalChatId}`);
  }

  // Find the index of the message to branch from
  const messageIndex = originalChat.items.findIndex(item => item.id === messageId);
  if (messageIndex === -1) {
    throw new Error(`Message not found: ${messageId}`);
  }

  // Slice items up to and including the message
  const newItems = originalChat.items.slice(0, messageIndex + 1);

  // Create new chat with these items
  // Note: We need to deep copy items to avoid reference issues if we modify them later
  // Also need to handle attachments (copy them or reference them?)
  // For now, simple JSON clone. Attachments are referenced by ID, so they can be shared 
  // until we delete the original chat.
  // Ideally we should copy attachments to new IDs so deleting one chat doesn't break the other's images.
  // But given s3Storage implementation, attachments are stored by (userId, chatId, attachmentId).
  // If we want a true independent copy, we need to copy S3 objects too.
  
  // For MVP/Simplicity: We will copy the item structure.
  // WARNING: If we delete the original chat, the attachments might be lost if we don't copy them in S3.
  // However, deleteAttachments uses (userId, chatId) prefix.
  // So we MUST copy attachments to the new chat ID context.
  
  const chatId = generateId();
  const processedItems = [];

  for (const item of newItems) {
    const newItem = { ...item };
    
    if (newItem.attachments && newItem.attachments.length > 0) {
      const newAttachments = [];
      for (const att of newItem.attachments) {
        if (att.attachmentId) {
            // Load original attachment
            const loaded = await loadAttachment(userId, originalChatId, att.attachmentId);
            if (loaded) {
                // Save as new attachment for new chat
                const newAttId = generateAttachmentId();
                await saveAttachment(userId, chatId, newAttId, loaded.data, att.type);
                
                newAttachments.push({
                    ...att,
                    attachmentId: newAttId
                });
            } else {
                // If failed to load, just keep reference (might be broken)
                newAttachments.push({ ...att });
            }
        } else {
            newAttachments.push({ ...att });
        }
      }
      newItem.attachments = newAttachments;
    }
    processedItems.push(newItem);
  }

  const now = new Date().toISOString();
  const newChat = {
    id: chatId,
    userId,
    title: `${originalChat.title} (Branch)`,
    agentId: originalChat.agentId,
    items: processedItems,
    createdAt: now,
    updatedAt: now
  };

  await saveJson(getChatKey(userId, chatId), newChat);
  return newChat;
}

/**
 * Generate a smart title from the first user message
 */
export function generateTitleFromMessage(message) {
  if (!message) return 'New Chat';
  
  // Clean and truncate
  let title = message
    .replace(/\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  
  // Truncate at reasonable length, try to break at word boundary
  if (title.length > 50) {
    title = title.substring(0, 50);
    const lastSpace = title.lastIndexOf(' ');
    if (lastSpace > 30) {
      title = title.substring(0, lastSpace);
    }
    title += '...';
  }
  
  return title || 'New Chat';
}
