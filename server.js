const WebSocket = require('ws');
const http = require('http');
const { v4: uuidv4 } = require('uuid');

// Push API URL for notifications
const PUSH_API_URL = process.env.PUSH_API_URL || 'https://octopus-push-api-production-677b.up.railway.app';

// Helper function to create unified channel (MUST match client!)
function createUnifiedChannel(type, userId1, userId2) {
  const sortedIds = [userId1, userId2].sort();
  return `${type}-${sortedIds.join('-')}`;
}

// Create HTTP server
const server = http.createServer((req, res) => {
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
      connections: clientManager.clients.size,
      channels: channelManager.channels.size,
      presenceChannels: presenceManager.presenceData.size
    }));
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }
});

// Create WebSocket server
const wss = new WebSocket.Server({ 
  server,
  perMessageDeflate: { zlibDeflateOptions: { level: 9 } }
});

// Client Manager
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
    console.log(`✅ Client ${clientId} connected. Total: ${this.clients.size}`);
  }

  removeClient(clientId) {
    if (this.clients.has(clientId)) {
      this.clients.delete(clientId);
      this.clientMetadata.delete(clientId);
      console.log(`❌ Client ${clientId} disconnected. Total: ${this.clients.size}`);
    }
  }

  getClient(clientId) {
    return this.clients.get(clientId);
  }

  updateActivity(clientId) {
    const metadata = this.clientMetadata.get(clientId);
    if (metadata) metadata.lastActivity = new Date().toISOString();
  }

  isClientConnected(clientId) {
    const client = this.clients.get(clientId);
    return client && client.readyState === WebSocket.OPEN;
  }
}

// Channel Manager
class ChannelManager {
  constructor() {
    this.channels = new Map();
    this.channelMetadata = new Map();
  }

  subscribe(channelName, client) {
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
      if (metadata) metadata.messageCount++;

      let sentCount = 0;
      channel.forEach(client => {
        if (client !== excludeClient && client.readyState === WebSocket.OPEN) {
          try {
            client.send(JSON.stringify(message));
            sentCount++;
          } catch (error) {
            console.error(`❌ Error sending to ${client.clientId}:`, error.message);
            channel.delete(client);
          }
        }
      });
      
      console.log(`📤 Broadcast to ${channelName}: ${sentCount} recipients`);
    } else {
      console.warn(`⚠️ Channel ${channelName} not found for broadcast`);
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

// Presence Manager
class PresenceManager {
  constructor() {
    this.presenceData = new Map();
    this.userPresence = new Map();
  }

  enter(presenceChannel, clientId) {
    if (!this.presenceData.has(presenceChannel)) {
      this.presenceData.set(presenceChannel, new Set());
    }
    this.presenceData.get(presenceChannel).add(clientId);

    if (!this.userPresence.has(clientId)) {
      this.userPresence.set(clientId, new Set());
    }
    this.userPresence.get(clientId).add(presenceChannel);

    return Array.from(this.presenceData.get(presenceChannel));
  }

  leave(presenceChannel, clientId) {
    if (this.presenceData.has(presenceChannel)) {
      this.presenceData.get(presenceChannel).delete(clientId);
      if (this.presenceData.get(presenceChannel).size === 0) {
        this.presenceData.delete(presenceChannel);
      }
    }

    if (this.userPresence.has(clientId)) {
      this.userPresence.get(clientId).delete(presenceChannel);
      if (this.userPresence.get(clientId).size === 0) {
        this.userPresence.delete(clientId);
      }
    }

    return this.presenceData.has(presenceChannel) ? 
           Array.from(this.presenceData.get(presenceChannel)) : [];
  }

  leaveAll(clientId) {
    const userChannels = this.userPresence.get(clientId);
    if (userChannels) {
      userChannels.forEach(channel => this.leave(channel, clientId));
    }
  }

  getMembers(presenceChannel) {
    return this.presenceData.has(presenceChannel) ? 
           Array.from(this.presenceData.get(presenceChannel)) : [];
  }
}

// Initialize managers
const clientManager = new ClientManager();
const channelManager = new ChannelManager();
const presenceManager = new PresenceManager();

// Helper: Send call notification via Push API
async function sendCallNotification(callerId, receiverId, callType) {
  try {
    const response = await fetch(`${PUSH_API_URL}/api/push/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        caller_id: callerId,
        receiver_id: receiverId,
        call_type: callType
      })
    });
    
    if (response.ok) {
      console.log(`📱 Call notification sent: ${callerId} → ${receiverId} (${callType})`);
    }
  } catch (error) {
    console.error('❌ Failed to send call notification:', error.message);
  }
}

// Rate limiting
const rateLimiter = new Map();
const RATE_LIMIT_WINDOW = 60000;
const RATE_LIMIT_MAX_REQUESTS = 100;

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
  console.log('🔗 New connection from', req.socket.remoteAddress);
  
  const connectionTimeout = setTimeout(() => {
    if (!ws.clientId) {
      ws.close(1000, 'No client identification');
    }
  }, 30000);

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      const { type, clientId, channel, payload } = message;

      if (!type || !clientId) {
        ws.send(JSON.stringify({ type: 'error', error: 'Missing type or clientId' }));
        return;
      }

      if (!checkRateLimit(clientId)) {
        ws.send(JSON.stringify({ type: 'error', error: 'Rate limit exceeded' }));
        return;
      }

      if (!ws.clientId) {
        clearTimeout(connectionTimeout);
        clientManager.addClient(clientId, ws, { ip: req.socket.remoteAddress });
      }

      clientManager.updateActivity(clientId);

      switch (type) {
        case 'subscribe':
          if (!channel) {
            ws.send(JSON.stringify({ type: 'error', error: 'Channel required' }));
            return;
          }
          channelManager.subscribe(channel, ws);
          // FIX: Send channel in payload to match client expectations
          ws.send(JSON.stringify({ 
            type: 'subscribed', 
            payload: { channel },
            channel  // Also keep at root for compatibility
          }));
          break;

        case 'unsubscribe':
          if (!channel) {
            ws.send(JSON.stringify({ type: 'error', error: 'Channel required' }));
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
          channelManager.broadcast(presenceChannel, {
            type: 'presence-enter',
            clientId: clientId,
            members: members
          }, ws);
          
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
          channelManager.broadcast(leaveChannel, {
            type: 'presence-leave',
            clientId: clientId,
            members: remainingMembers
          });
          break;

        case 'presence-get-members':
          const getMembersChannel = payload?.presenceChannel;
          if (!getMembersChannel) {
            ws.send(JSON.stringify({ type: 'error', error: 'Presence channel required' }));
            return;
          }
          
          const currentMembers = presenceManager.getMembers(getMembersChannel);
          ws.send(JSON.stringify({
            type: 'presence-members',
            channel: getMembersChannel,
            members: currentMembers
          }));
          break;

        case 'message':
          if (!payload?.senderId || !payload?.receiverId) {
            ws.send(JSON.stringify({ type: 'error', error: 'Sender and receiver required' }));
            return;
          }
          
          const messageData = {
            ...payload,
            id: payload.id || uuidv4(),
            timestamp: payload.timestamp || new Date().toISOString()
          };
          
          // FIX: Use unified channel creation
          const chatChannel = createUnifiedChannel('chat', payload.senderId, payload.receiverId);
          channelManager.broadcast(chatChannel, { type: 'newMessage', data: messageData });
          break;

        case 'typing':
          if (!payload?.senderId || !payload?.receiverId) {
            ws.send(JSON.stringify({ type: 'error', error: 'Sender and receiver required' }));
            return;
          }
          
          // FIX: Use unified channel creation
          const typingChannel = createUnifiedChannel('chat', payload.senderId, payload.receiverId);
          channelManager.broadcast(typingChannel, { type: 'typing', data: payload }, ws);
          break;

        case 'message-seen':
          if (!payload?.messageId || !payload?.senderId || !payload?.receiverId) {
            ws.send(JSON.stringify({ type: 'error', error: 'Message ID, sender and receiver required' }));
            return;
          }
          
          // FIX: Use unified channel creation
          const seenChannel = createUnifiedChannel('chat', payload.senderId, payload.receiverId);
          channelManager.broadcast(seenChannel, {
            type: 'messageSeenAcknowledgment',
            data: { id: payload.messageId, seenBy: payload.senderId, seenAt: new Date().toISOString() }
          });
          break;

        // WebRTC with call notifications - USE CLIENT'S CHANNEL!
        case 'rtc-offer':
          if (!channel || !payload?.from || !payload?.to || !payload?.offer || !payload?.callType) {
            ws.send(JSON.stringify({ type: 'error', error: 'Invalid RTC offer' }));
            return;
          }
          
          console.log(`📞 Offer on channel: ${channel}`);
          
          // Send push notification for incoming call
          sendCallNotification(payload.from, payload.to, payload.callType);
          
          // FIX: Use the channel provided by client
          channelManager.broadcast(channel, {
            type: 'offer',
            data: { ...payload.offer, from: payload.from, callType: payload.callType }
          });
          console.log(`📞 ${payload.callType} call: ${payload.from} → ${payload.to}`);
          break;

        case 'rtc-answer':
          if (!channel || !payload?.from || !payload?.to || !payload?.answer) {
            ws.send(JSON.stringify({ type: 'error', error: 'Invalid RTC answer' }));
            return;
          }
          
          console.log(`📞 Answer on channel: ${channel}`);
          
          // FIX: Use the channel provided by client
          channelManager.broadcast(channel, {
            type: 'answer',
            data: { ...payload.answer, from: payload.from }
          });
          console.log(`📞 Call answered: ${payload.from} → ${payload.to}`);
          break;

        case 'rtc-ice-candidate':
          if (!channel || !payload?.from || !payload?.to || !payload?.candidate) {
            ws.send(JSON.stringify({ type: 'error', error: 'Invalid ICE candidate' }));
            return;
          }
          
          // FIX: Use the channel provided by client
          const iceMessage = { type: 'ice-candidate', data: { ...payload.candidate, from: payload.from } };
          channelManager.broadcast(channel, iceMessage);
          break;

        case 'rtc-call-ended':
          if (!channel || !payload?.from || !payload?.to) {
            ws.send(JSON.stringify({ type: 'error', error: 'Invalid call end' }));
            return;
          }
          
          // FIX: Use the channel provided by client
          const endMessage = { type: 'call-ended', data: { from: payload.from, reason: payload.reason || 'ended' } };
          channelManager.broadcast(channel, endMessage);
          console.log(`📞 Call ended: ${payload.from}`);
          break;

        case 'rtc-call-rejected':
          if (!channel || !payload?.from || !payload?.to) {
            ws.send(JSON.stringify({ type: 'error', error: 'Invalid rejection' }));
            return;
          }
          
          // FIX: Use the channel provided by client
          const rejectMessage = { type: 'call-rejected', data: { from: payload.from } };
          channelManager.broadcast(channel, rejectMessage);
          console.log(`📞 Call rejected: ${payload.from}`);
          break;

        case 'ping':
          ws.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }));
          break;

        default:
          ws.send(JSON.stringify({ type: 'error', error: `Unknown type: ${type}` }));
          break;
      }
    } catch (error) {
      console.error('❌ Error processing message:', error);
      ws.send(JSON.stringify({ type: 'error', error: 'Invalid message' }));
    }
  });

  ws.on('close', (code, reason) => {
    clearTimeout(connectionTimeout);
    
    if (ws.clientId) {
      const userChannels = presenceManager.userPresence.get(ws.clientId);
      
      if (userChannels) {
        userChannels.forEach(presenceChannel => {
          const remainingMembers = presenceManager.leave(presenceChannel, ws.clientId);
          channelManager.broadcast(presenceChannel, {
            type: 'presence-leave',
            clientId: ws.clientId,
            members: remainingMembers
          });
        });
      } else {
        presenceManager.leaveAll(ws.clientId);
      }
      
      channelManager.unsubscribeFromAll(ws);
      clientManager.removeClient(ws.clientId);
    }
  });

  ws.on('error', (error) => {
    console.error(`❌ WebSocket error for ${ws.clientId || 'unknown'}:`, error.message);
  });

  ws.send(JSON.stringify({
    type: 'connection',
    message: 'Connected to chat server',
    timestamp: new Date().toISOString()
  }));
});

// Cleanup dead connections
setInterval(() => {
  const now = Date.now();
  
  rateLimiter.forEach((data, clientId) => {
    if (now - data.windowStart > RATE_LIMIT_WINDOW * 2) {
      rateLimiter.delete(clientId);
    }
  });
  
  clientManager.clients.forEach((client, clientId) => {
    if (client.readyState === WebSocket.CLOSED) {
      presenceManager.leaveAll(clientId);
      channelManager.unsubscribeFromAll(client);
      clientManager.removeClient(clientId);
    }
  });
}, 300000);

// Graceful shutdown
const shutdown = () => {
  wss.clients.forEach(client => {
    client.send(JSON.stringify({ type: 'server-shutdown' }));
    client.close(1000, 'Server shutdown');
  });
  server.close(() => process.exit(0));
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 WebSocket server running on port ${PORT}`);
  console.log(`📡 Push API: ${PUSH_API_URL}`);
});
