const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// Create HTTP server
const server = http.createServer((req, res) => {
  // Add CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      status: 'OK', 
      timestamp: new Date().toISOString(),
      connections: clients.size,
      channels: channels.size,
      presenceChannels: presenceData.size
    }));
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }
});

// Create WebSocket server with enhanced options
const wss = new WebSocket.Server({ 
  server,
  perMessageDeflate: {
    zlibDeflateOptions: {
      level: 9,
    }
  }
});

// Enhanced client storage with metadata
class ClientManager {
  constructor() {
    this.clients = new Map();
    this.clientMetadata = new Map();
  }

  addClient(clientId, ws, metadata = {}) {
    this.clients.set(clientId, ws);
    this.clientMetadata.set(clientId, {
      ...metadata,
      connectedAt: new Date().toISOString(),
      lastActivity: new Date().toISOString()
    });
    ws.clientId = clientId;
    console.log(`✅ Client ${clientId} connected. Total clients: ${this.clients.size}`);
  }

  removeClient(clientId) {
    if (this.clients.has(clientId)) {
      this.clients.delete(clientId);
      this.clientMetadata.delete(clientId);
      console.log(`❌ Client ${clientId} disconnected. Total clients: ${this.clients.size}`);
    }
  }

  getClient(clientId) {
    return this.clients.get(clientId);
  }

  updateActivity(clientId) {
    const metadata = this.clientMetadata.get(clientId);
    if (metadata) {
      metadata.lastActivity = new Date().toISOString();
    }
  }

  isClientConnected(clientId) {
    const client = this.clients.get(clientId);
    return client && client.readyState === WebSocket.OPEN;
  }

  getConnectedClients() {
    return Array.from(this.clients.keys()).filter(clientId => this.isClientConnected(clientId));
  }
}

// Enhanced channel management
class ChannelManager {
  constructor() {
    this.channels = new Map();
    this.channelMetadata = new Map();
  }

  subscribe(channelName, client, metadata = {}) {
    if (!this.channels.has(channelName)) {
      this.channels.set(channelName, new Set());
      this.channelMetadata.set(channelName, {
        createdAt: new Date().toISOString(),
        messageCount: 0
      });
    }
    
    this.channels.get(channelName).add(client);
    console.log(`📡 Client ${client.clientId} subscribed to ${channelName}`);
  }

  unsubscribe(channelName, client) {
    const channel = this.channels.get(channelName);
    if (channel) {
      channel.delete(client);
      if (channel.size === 0) {
        this.channels.delete(channelName);
        this.channelMetadata.delete(channelName);
        console.log(`🗑️  Channel ${channelName} deleted (no subscribers)`);
      }
    }
  }

  unsubscribeFromAll(client) {
    this.channels.forEach((clientSet, channelName) => {
      clientSet.delete(client);
      if (clientSet.size === 0) {
        this.channels.delete(channelName);
        this.channelMetadata.delete(channelName);
      }
    });
  }

  broadcast(channelName, message, excludeClient = null) {
    const channel = this.channels.get(channelName);
    if (channel) {
      const metadata = this.channelMetadata.get(channelName);
      if (metadata) {
        metadata.messageCount++;
      }

      let sentCount = 0;
      channel.forEach(client => {
        if (client !== excludeClient && client.readyState === WebSocket.OPEN) {
          try {
            client.send(JSON.stringify(message));
            sentCount++;
          } catch (error) {
            console.error(`❌ Error sending to client ${client.clientId}:`, error.message);
            // Remove dead connection
            channel.delete(client);
          }
        }
      });
      
      if (sentCount > 0) {
        console.log(`📤 Broadcasted to ${sentCount} clients in ${channelName}`);
      }
    }
  }

  getChannelInfo(channelName) {
    const channel = this.channels.get(channelName);
    const metadata = this.channelMetadata.get(channelName);
    return {
      exists: !!channel,
      subscriberCount: channel ? channel.size : 0,
      metadata: metadata || null
    };
  }
}

// Enhanced presence management
class PresenceManager {
  constructor() {
    this.presenceData = new Map();
    this.userPresence = new Map(); // Track which channels each user is in
  }

  enter(presenceChannel, clientId) {
    // Add to presence channel
    if (!this.presenceData.has(presenceChannel)) {
      this.presenceData.set(presenceChannel, new Set());
    }
    this.presenceData.get(presenceChannel).add(clientId);

    // Track user's presence channels
    if (!this.userPresence.has(clientId)) {
      this.userPresence.set(clientId, new Set());
    }
    this.userPresence.get(clientId).add(presenceChannel);

    console.log(`👋 Client ${clientId} entered presence channel ${presenceChannel}`);
    
    return Array.from(this.presenceData.get(presenceChannel));
  }

  leave(presenceChannel, clientId) {
    if (this.presenceData.has(presenceChannel)) {
      this.presenceData.get(presenceChannel).delete(clientId);
      
      // Clean up empty channels
      if (this.presenceData.get(presenceChannel).size === 0) {
        this.presenceData.delete(presenceChannel);
      }
    }

    // Remove from user's presence tracking
    if (this.userPresence.has(clientId)) {
      this.userPresence.get(clientId).delete(presenceChannel);
      if (this.userPresence.get(clientId).size === 0) {
        this.userPresence.delete(clientId);
      }
    }

    console.log(`👋 Client ${clientId} left presence channel ${presenceChannel}`);
    
    return this.presenceData.has(presenceChannel) ? 
           Array.from(this.presenceData.get(presenceChannel)) : [];
  }

  leaveAll(clientId) {
    const userChannels = this.userPresence.get(clientId);
    if (userChannels) {
      userChannels.forEach(channel => {
        this.leave(channel, clientId);
      });
    }
  }

  getMembers(presenceChannel) {
    return this.presenceData.has(presenceChannel) ? 
           Array.from(this.presenceData.get(presenceChannel)) : [];
  }

  isUserOnline(userId, presenceChannel) {
    return this.presenceData.has(presenceChannel) && 
           this.presenceData.get(presenceChannel).has(userId);
  }
}

// Initialize managers
const clientManager = new ClientManager();
const channelManager = new ChannelManager();
const presenceManager = new PresenceManager();

// Legacy references for backward compatibility
const clients = clientManager.clients;
const channels = channelManager.channels;
const presenceData = presenceManager.presenceData;

// Helper functions
function sendToClient(clientId, message) {
  const client = clientManager.getClient(clientId);
  if (client && client.readyState === WebSocket.OPEN) {
    try {
      client.send(JSON.stringify(message));
      return true;
    } catch (error) {
      console.error(`❌ Error sending to client ${clientId}:`, error.message);
      return false;
    }
  }
  return false;
}

function generateChannelName(type, userId1, userId2) {
  const sortedIds = [userId1, userId2].sort();
  return `${type}-${sortedIds[0]}-${sortedIds[1]}`;
}

function validateMessage(message) {
  if (!message || typeof message !== 'object') {
    return { valid: false, error: 'Invalid message format' };
  }

  const { type, clientId } = message;
  if (!type || !clientId) {
    return { valid: false, error: 'Missing required fields: type, clientId' };
  }

  return { valid: true };
}

// Rate limiting
const rateLimiter = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 100; // Max requests per window

function checkRateLimit(clientId) {
  const now = Date.now();
  const clientLimiter = rateLimiter.get(clientId) || { count: 0, windowStart: now };
  
  if (now - clientLimiter.windowStart > RATE_LIMIT_WINDOW) {
    clientLimiter.count = 0;
    clientLimiter.windowStart = now;
  }
  
  clientLimiter.count++;
  rateLimiter.set(clientId, clientLimiter);
  
  return clientLimiter.count <= RATE_LIMIT_MAX_REQUESTS;
}

// WebSocket connection handling
wss.on('connection', (ws, req) => {
  console.log('🔗 New WebSocket connection from', req.socket.remoteAddress);
  
  // Connection timeout
  const connectionTimeout = setTimeout(() => {
    if (!ws.clientId) {
      console.log('⏰ Closing connection due to no client identification');
      ws.close(1000, 'No client identification received');
    }
  }, 30000); // 30 seconds to identify

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      const validation = validateMessage(message);
      
      if (!validation.valid) {
        ws.send(JSON.stringify({
          type: 'error',
          error: validation.error
        }));
        return;
      }

      const { type, clientId, channel, payload } = message;

      // Rate limiting
      if (!checkRateLimit(clientId)) {
        ws.send(JSON.stringify({
          type: 'error',
          error: 'Rate limit exceeded'
        }));
        return;
      }

      // Clear connection timeout on first valid message
      if (!ws.clientId) {
        clearTimeout(connectionTimeout);
        clientManager.addClient(clientId, ws, { ip: req.socket.remoteAddress });
      }

      // Update client activity
      clientManager.updateActivity(clientId);

      // Handle different message types
      switch (type) {
        case 'subscribe':
          if (!channel) {
            ws.send(JSON.stringify({ type: 'error', error: 'Channel name required' }));
            return;
          }
          channelManager.subscribe(channel, ws);
          ws.send(JSON.stringify({ 
            type: 'subscribed', 
            channel,
            info: channelManager.getChannelInfo(channel)
          }));
          break;

        case 'unsubscribe':
          if (!channel) {
            ws.send(JSON.stringify({ type: 'error', error: 'Channel name required' }));
            return;
          }
          channelManager.unsubscribe(channel, ws);
          ws.send(JSON.stringify({ type: 'unsubscribed', channel }));
          break;

        case 'presence-enter':
          const presenceChannel = payload?.presenceChannel;
          if (!presenceChannel) {
            ws.send(JSON.stringify({ type: 'error', error: 'Presence channel required' }));
            return;
          }
          
          const members = presenceManager.enter(presenceChannel, clientId);
          
          // Notify other clients in presence channel
          channelManager.broadcast(presenceChannel, {
            type: 'presence-enter',
            clientId: clientId,
            members: members
          }, ws);
          
          // Send current members to joining client
          ws.send(JSON.stringify({
            type: 'presence-members',
            channel: presenceChannel,
            members: members
          }));
          break;

        case 'presence-leave':
          const leaveChannel = payload?.presenceChannel;
          if (!leaveChannel) {
            ws.send(JSON.stringify({ type: 'error', error: 'Presence channel required' }));
            return;
          }
          
          const remainingMembers = presenceManager.leave(leaveChannel, clientId);
          
          // Notify other clients in presence channel
          channelManager.broadcast(leaveChannel, {
            type: 'presence-leave',
            clientId: clientId,
            members: remainingMembers
          });
          break;

        case 'presence-get':
          const getChannel = payload?.presenceChannel;
          if (!getChannel) {
            ws.send(JSON.stringify({ type: 'error', error: 'Presence channel required' }));
            return;
          }
          
          ws.send(JSON.stringify({
            type: 'presence-members',
            channel: getChannel,
            members: presenceManager.getMembers(getChannel)
          }));
          break;

        case 'message':
          if (!payload?.senderId || !payload?.receiverId) {
            ws.send(JSON.stringify({ type: 'error', error: 'Sender and receiver IDs required' }));
            return;
          }
          
          const messageData = {
            ...payload,
            id: payload.id || uuidv4(),
            timestamp: payload.timestamp || new Date().toISOString(),
            serverProcessed: new Date().toISOString()
          };
          
          const messagePayload = {
            type: 'newMessage',
            data: messageData
          };
          
          // Broadcast to both channel directions
          const channelA = `chat-${payload.senderId}-${payload.receiverId}`;
          const channelB = `chat-${payload.receiverId}-${payload.senderId}`;
          
          channelManager.broadcast(channelA, messagePayload);
          channelManager.broadcast(channelB, messagePayload);
          
          console.log(`💬 Message from ${payload.senderId} to ${payload.receiverId}`);
          break;

        case 'typing':
          if (!payload?.senderId || !payload?.receiverId) {
            ws.send(JSON.stringify({ type: 'error', error: 'Sender and receiver IDs required' }));
            return;
          }
          
          const typingPayload = {
            type: 'typing',
            data: {
              ...payload,
              timestamp: new Date().toISOString()
            }
          };
          
          const typingChannelA = `chat-${payload.senderId}-${payload.receiverId}`;
          const typingChannelB = `chat-${payload.receiverId}-${payload.senderId}`;
          
          channelManager.broadcast(typingChannelA, typingPayload, ws);
          channelManager.broadcast(typingChannelB, typingPayload, ws);
          break;

        case 'message-seen':
          if (!payload?.messageId || !payload?.senderId || !payload?.receiverId) {
            ws.send(JSON.stringify({ type: 'error', error: 'Message ID, sender and receiver IDs required' }));
            return;
          }
          
          const seenPayload = {
            type: 'messageSeenAcknowledgment',
            data: { 
              id: payload.messageId,
              seenBy: payload.senderId,
              seenAt: new Date().toISOString()
            }
          };
          
          const seenChannelA = `chat-${payload.senderId}-${payload.receiverId}`;
          const seenChannelB = `chat-${payload.receiverId}-${payload.senderId}`;
          
          channelManager.broadcast(seenChannelA, seenPayload);
          channelManager.broadcast(seenChannelB, seenPayload);
          break;

        // WebRTC signaling with enhanced error handling
        case 'rtc-offer':
          if (!payload?.from || !payload?.to || !payload?.offer) {
            ws.send(JSON.stringify({ type: 'error', error: 'Invalid RTC offer data' }));
            return;
          }
          
          const offerChannel = `rtc-${payload.to}-${payload.from}`;
          const offerMessage = {
            type: 'offer',
            data: {
              ...payload.offer,
              from: payload.from,
              timestamp: new Date().toISOString()
            }
          };
          
          channelManager.broadcast(offerChannel, offerMessage);
          console.log(`📞 RTC offer from ${payload.from} to ${payload.to}`);
          break;

        case 'rtc-answer':
          if (!payload?.from || !payload?.to || !payload?.answer) {
            ws.send(JSON.stringify({ type: 'error', error: 'Invalid RTC answer data' }));
            return;
          }
          
          const answerChannel = `rtc-${payload.from}-${payload.to}`;
          channelManager.broadcast(answerChannel, {
            type: 'answer',
            data: {
              ...payload.answer,
              from: payload.from,
              timestamp: new Date().toISOString()
            }
          });
          console.log(`📞 RTC answer from ${payload.from} to ${payload.to}`);
          break;

        case 'rtc-ice-candidate':
          if (!payload?.from || !payload?.to || !payload?.candidate) {
            ws.send(JSON.stringify({ type: 'error', error: 'Invalid ICE candidate data' }));
            return;
          }
          
          const iceChannelA = `rtc-${payload.from}-${payload.to}`;
          const iceChannelB = `rtc-${payload.to}-${payload.from}`;
          
          const iceMessage = {
            type: 'ice-candidate',
            data: {
              ...payload.candidate,
              from: payload.from,
              timestamp: new Date().toISOString()
            }
          };
          
          channelManager.broadcast(iceChannelA, iceMessage);
          channelManager.broadcast(iceChannelB, iceMessage);
          console.log(`🧊 ICE candidate from ${payload.from} to ${payload.to}`);
          break;

        case 'rtc-call-ended':
          if (!payload?.from || !payload?.to) {
            ws.send(JSON.stringify({ type: 'error', error: 'Invalid call end data' }));
            return;
          }
          
          const endChannelA = `rtc-${payload.from}-${payload.to}`;
          const endChannelB = `rtc-${payload.to}-${payload.from}`;
          
          const endMessage = {
            type: 'call-ended',
            data: { 
              from: payload.from,
              reason: payload.reason || 'ended',
              timestamp: new Date().toISOString()
            }
          };
          
          channelManager.broadcast(endChannelA, endMessage);
          channelManager.broadcast(endChannelB, endMessage);
          console.log(`📞❌ Call ended by ${payload.from}`);
          break;

        case 'rtc-call-rejected':
          if (!payload?.from || !payload?.to) {
            ws.send(JSON.stringify({ type: 'error', error: 'Invalid call rejection data' }));
            return;
          }
          
          const rejectChannelA = `rtc-${payload.from}-${payload.to}`;
          const rejectChannelB = `rtc-${payload.to}-${payload.from}`;
          
          const rejectMessage = {
            type: 'call-rejected',
            data: { 
              from: payload.from,
              timestamp: new Date().toISOString()
            }
          };
          
          channelManager.broadcast(rejectChannelA, rejectMessage);
          channelManager.broadcast(rejectChannelB, rejectMessage);
          console.log(`📞❌ Call rejected by ${payload.from}`);
          break;

        case 'ping':
          ws.send(JSON.stringify({ 
            type: 'pong', 
            timestamp: new Date().toISOString() 
          }));
          break;

        case 'get-status':
          ws.send(JSON.stringify({
            type: 'status',
            data: {
              clientId: clientId,
              connected: true,
              serverTime: new Date().toISOString(),
              totalClients: clientManager.clients.size,
              totalChannels: channelManager.channels.size
            }
          }));
          break;

        default:
          ws.send(JSON.stringify({ 
            type: 'error', 
            error: `Unknown message type: ${type}` 
          }));
          console.log('❓ Unknown message type:', type);
          break;
      }
    } catch (error) {
      console.error('❌ Error processing message:', error);
      ws.send(JSON.stringify({
        type: 'error',
        error: 'Invalid message format or server error'
      }));
    }
  });
  // REPLACE the ws.on('close') handler with this fixed version:

ws.on('close', (code, reason) => {
  clearTimeout(connectionTimeout);
  console.log(`🔌 Client ${ws.clientId} disconnected (${code}): ${reason || 'No reason'}`);
  
  if (ws.clientId) {
    // Get all presence channels the user was in BEFORE removing them
    const userChannels = presenceManager.userPresence.get(ws.clientId);
    
    // Broadcast presence-leave to each channel
    if (userChannels) {
      userChannels.forEach(presenceChannel => {
        // Remove user from presence
        const remainingMembers = presenceManager.leave(presenceChannel, ws.clientId);
        
        // Broadcast to other clients in the channel
        channelManager.broadcast(presenceChannel, {
          type: 'presence-leave',
          clientId: ws.clientId,
          members: remainingMembers
        });
        
        console.log(`👋 Broadcasted presence-leave for ${ws.clientId} in ${presenceChannel}`);
      });
    } else {
      // Fallback: remove from all presence channels without broadcasting
      presenceManager.leaveAll(ws.clientId);
    }
    
    // Unsubscribe from all channels
    channelManager.unsubscribeFromAll(ws);
    
    // Remove client
    clientManager.removeClient(ws.clientId);
  }
});

  // Handle errors
  ws.on('error', (error) => {
    console.error(`❌ WebSocket error for client ${ws.clientId || 'unknown'}:`, error.message);
  });

  // Send welcome message
  ws.send(JSON.stringify({
    type: 'connection',
    message: 'Connected to enhanced chat server',
    timestamp: new Date().toISOString(),
    serverVersion: '2.0.0'
  }));
});

// Periodic cleanup for dead connections and rate limiting
setInterval(() => {
  const now = Date.now();
  
  // Clean up rate limiter
  rateLimiter.forEach((data, clientId) => {
    if (now - data.windowStart > RATE_LIMIT_WINDOW * 2) {
      rateLimiter.delete(clientId);
    }
  });
  
  // Clean up dead WebSocket connections
  clientManager.clients.forEach((client, clientId) => {
    if (client.readyState === WebSocket.CLOSED) {
      console.log(`🧹 Cleaning up dead connection: ${clientId}`);
      presenceManager.leaveAll(clientId);
      channelManager.unsubscribeFromAll(client);
      clientManager.removeClient(clientId);
    }
  });
  
}, 300000); // Every 5 minutes

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 Received SIGTERM, shutting down gracefully...');
  wss.clients.forEach(client => {
    client.send(JSON.stringify({
      type: 'server-shutdown',
      message: 'Server is shutting down'
    }));
    client.close(1000, 'Server shutdown');
  });
  server.close(() => {
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('🛑 Received SIGINT, shutting down gracefully...');
  wss.clients.forEach(client => {
    client.send(JSON.stringify({
      type: 'server-shutdown',
      message: 'Server is shutting down'
    }));
    client.close(1000, 'Server shutdown');
  });
  server.close(() => {
    process.exit(0);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Enhanced WebSocket server running on port ${PORT}`);
  console.log(`📡 WebSocket endpoint: ws://localhost:${PORT}`);
  console.log(`🌐 Health check: http://localhost:${PORT}/health`);
});
