const WebSocket = require('ws');
const http = require('http');
const { v4: uuidv4 } = require('uuid');

const PUSH_API_URL = process.env.PUSH_API_URL || 'https://octopus-push-api-production-677b.up.railway.app';
const PORT = process.env.PORT || 3000;
const RATE_LIMIT_WINDOW = 60000;
const RATE_LIMIT_MAX_REQUESTS = 100;
const CONNECTION_TIMEOUT = 30000;
const CLEANUP_INTERVAL = 300000;

function createUnifiedChannel(type, userId1, userId2) {
  const sortedIds = [userId1, userId2].sort();
  return `${type}-${sortedIds.join('-')}`;
}

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

const wss = new WebSocket.Server({ 
  server,
  perMessageDeflate: { zlibDeflateOptions: { level: 9 } }
});

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
  }

  removeClient(clientId) {
    if (this.clients.has(clientId)) {
      this.clients.delete(clientId);
      this.clientMetadata.delete(clientId);
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

      channel.forEach(client => {
        if (client !== excludeClient && client.readyState === WebSocket.OPEN) {
          try {
            client.send(JSON.stringify(message));
          } catch (error) {
            channel.delete(client);
          }
        }
      });
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

const clientManager = new ClientManager();
const channelManager = new ChannelManager();
const presenceManager = new PresenceManager();
const rateLimiter = new Map();

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
  } catch (error) {
    // Silent fail
  }
}

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

wss.on('connection', (ws, req) => {
  const connectionTimeout = setTimeout(() => {
    if (!ws.clientId) {
      ws.close(1000, 'No client identification');
    }
  }, CONNECTION_TIMEOUT);

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
          ws.send(JSON.stringify({ 
            type: 'subscribed', 
            payload: { channel },
            channel
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
          
          const chatChannel = createUnifiedChannel('chat', payload.senderId, payload.receiverId);
          channelManager.broadcast(chatChannel, { type: 'newMessage', data: messageData });
          break;

        case 'typing':
          if (!payload?.senderId || !payload?.receiverId) {
            ws.send(JSON.stringify({ type: 'error', error: 'Sender and receiver required' }));
            return;
          }
          
          const typingChannel = createUnifiedChannel('chat', payload.senderId, payload.receiverId);
          channelManager.broadcast(typingChannel, { type: 'typing', data: payload }, ws);
          break;

        case 'message-seen':
          if (!payload?.messageId || !payload?.senderId || !payload?.receiverId) {
            ws.send(JSON.stringify({ type: 'error', error: 'Message ID, sender and receiver required' }));
            return;
          }
          
          const seenChannel = createUnifiedChannel('chat', payload.senderId, payload.receiverId);
          channelManager.broadcast(seenChannel, {
            type: 'messageSeenAcknowledgment',
            data: { 
              id: payload.messageId, 
              seenBy: payload.senderId, 
              seenAt: new Date().toISOString() 
            }
          });
          break;

        case 'rtc-offer':
          if (!channel || !payload?.from || !payload?.to || !payload?.offer || !payload?.callType) {
            ws.send(JSON.stringify({ type: 'error', error: 'Invalid RTC offer' }));
            return;
          }
          
          sendCallNotification(payload.from, payload.to, payload.callType);
          
          channelManager.broadcast(channel, {
            type: 'offer',
            data: { 
              ...payload.offer, 
              from: payload.from, 
              callType: payload.callType 
            }
          });
          break;

        case 'rtc-answer':
          if (!channel || !payload?.from || !payload?.to || !payload?.answer) {
            ws.send(JSON.stringify({ type: 'error', error: 'Invalid RTC answer' }));
            return;
          }
          
          channelManager.broadcast(channel, {
            type: 'answer',
            data: { 
              ...payload.answer, 
              from: payload.from 
            }
          });
          break;

        case 'rtc-ice-candidate':
          if (!channel || !payload?.from || !payload?.to || !payload?.candidate) {
            ws.send(JSON.stringify({ type: 'error', error: 'Invalid ICE candidate' }));
            return;
          }
          
          const iceMessage = { 
            type: 'ice-candidate', 
            data: { 
              ...payload.candidate, 
              from: payload.from 
            } 
          };
          channelManager.broadcast(channel, iceMessage);
          break;

        case 'rtc-call-ended':
          if (!channel || !payload?.from || !payload?.to) {
            ws.send(JSON.stringify({ type: 'error', error: 'Invalid call end' }));
            return;
          }
          
          const endMessage = { 
            type: 'call-ended', 
            data: { 
              from: payload.from, 
              reason: payload.reason || 'ended' 
            } 
          };
          channelManager.broadcast(channel, endMessage);
          break;

        case 'rtc-call-rejected':
          if (!channel || !payload?.from || !payload?.to) {
            ws.send(JSON.stringify({ type: 'error', error: 'Invalid rejection' }));
            return;
          }
          
          const rejectMessage = { 
            type: 'call-rejected', 
            data: { 
              from: payload.from 
            } 
          };
          channelManager.broadcast(channel, rejectMessage);
          break;

        case 'rtc-missed-call':
          if (!channel || !payload?.from || !payload?.to) {
            ws.send(JSON.stringify({ type: 'error', error: 'Invalid missed call' }));
            return;
          }
          
          channelManager.broadcast(channel, {
            type: 'missed-call',
            data: { 
              from: payload.from, 
              to: payload.to,
              callType: payload.callType,
              timestamp: payload.timestamp || Date.now()
            }
          });
          break;

        case 'ping':
          ws.send(JSON.stringify({ 
            type: 'pong', 
            timestamp: new Date().toISOString() 
          }));
          break;

        default:
          ws.send(JSON.stringify({ 
            type: 'error', 
            error: `Unknown type: ${type}` 
          }));
          break;
      }
    } catch (error) {
      ws.send(JSON.stringify({ 
        type: 'error', 
        error: 'Invalid message' 
      }));
    }
  });

  ws.on('close', () => {
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

  ws.on('error', () => {
    // Silent fail
  });

  ws.send(JSON.stringify({
    type: 'connection',
    message: 'Connected to chat server',
    timestamp: new Date().toISOString()
  }));
});

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
}, CLEANUP_INTERVAL);

const shutdown = () => {
  wss.clients.forEach(client => {
    client.send(JSON.stringify({ type: 'server-shutdown' }));
    client.close(1000, 'Server shutdown');
  });
  server.close(() => process.exit(0));
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(PORT, () => {
  console.log(`WebSocket server running on port ${PORT}`);
});
