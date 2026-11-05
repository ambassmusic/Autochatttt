import { 
  makeWASocket, 
  DisconnectReason, 
  fetchLatestBaileysVersion, 
  proto, 
  WASocket,
  WAMessage
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import QRCode from 'qrcode';
import pino from 'pino';
import { Server as SocketIOServer } from 'socket.io';
import { useDatabaseAuthState, clearDatabaseAuthState } from './databaseAuthState';
import { useSupabaseAuthState, clearSupabaseAuthState } from './supabaseAuthState';
import { messageQueue } from './messageQueue';
import { crmLeadStore } from './crmLeadStore';
import { whatsappOrderEngine } from './whatsappOrderEngine';
import { supabase } from '../services/supabaseClient';
import { Product } from '../types';

export type WhatsAppLifecycleStatus = 
  | 'INITIALIZING' 
  | 'QR_RECEIVED' 
  | 'PAIRING_CODE_RECEIVED' 
  | 'CONNECTING' 
  | 'CONNECTED' 
  | 'DISCONNECTED';

export interface WhatsAppInstanceSession {
  tenantId: string;
  sock: WASocket | null;
  status: WhatsAppLifecycleStatus;
  authMethod: 'QR' | 'PAIRING_CODE';
  phone?: string | null;
  verifiedName?: string | null;
  qrCode?: string | null;
  qrDataUrl?: string | null;
  pairingCode?: string | null;
  reconnectAttempts: number;
  reconnectTimer?: NodeJS.Timeout | null;
  lastConnectedAt?: string | null;
  lastError?: string | null;
  messages: Array<{
    id: string;
    from: string;
    body: string;
    timestamp: number;
    isOutgoing: boolean;
    fromMe?: boolean;
    mediaUrl?: string;
  }>;
}

/**
 * Normalizes any image URL to a verified, public HTTPS CDN URL.
 * Prevents WhatsApp from rejecting images hosted on localhost or private paths.
 */
export function ensurePublicCdnUrl(url?: string): string {
  if (!url) {
    return 'https://images.unsplash.com/photo-1596755094514-f87e34085b2c?auto=format&fit=crop&w=800&q=80';
  }
  if (url.startsWith('http://') || url.startsWith('https://')) {
    // If it's a localhost link, swap to cloud CDN fallback
    if (url.includes('localhost') || url.includes('127.0.0.1')) {
      return 'https://images.unsplash.com/photo-1596755094514-f87e34085b2c?auto=format&fit=crop&w=800&q=80';
    }
    return url;
  }
  // If it's a local relative path, map to public CDN image
  if (url.includes('linen') || url.includes('shirt')) {
    return 'https://images.unsplash.com/photo-1596755094514-f87e34085b2c?auto=format&fit=crop&w=800&q=80';
  }
  if (url.includes('leather') || url.includes('weekender') || url.includes('bag')) {
    return 'https://images.unsplash.com/photo-1553062407-98eeb64c6a62?auto=format&fit=crop&w=800&q=80';
  }
  if (url.includes('sneaker') || url.includes('shoe')) {
    return 'https://images.unsplash.com/photo-1549298916-b41d501d3772?auto=format&fit=crop&w=800&q=80';
  }
  if (url.includes('knit') || url.includes('cashmere')) {
    return 'https://images.unsplash.com/photo-1620799140408-edc6dcb6d633?auto=format&fit=crop&w=800&q=80';
  }
  return 'https://images.unsplash.com/photo-1596755094514-f87e34085b2c?auto=format&fit=crop&w=800&q=80';
}

/**
 * Isolated Microservice Engine managing multi-tenant WhatsApp connections,
 * database-backed session hydration, Socket.io events, and rate-limited dispatch.
 */
export class WhatsAppMicroservice {
  private sessions = new Map<string, WhatsAppInstanceSession>();
  private io: SocketIOServer | null = null;
  private logger = pino({ level: 'silent' });
  private tenantCatalogs = new Map<string, { storeName: string; currencySymbol: string; products: Product[] }>();

  constructor() {
    // Configure queue dispatcher to route through Baileys socket with rate limiting
    messageQueue.setDispatcher(async (tenantId, targetJid, payload) => {
      return this.dispatchRawMessage(tenantId, targetJid, payload);
    });
  }

  public setSocketServer(io: SocketIOServer): void {
    this.io = io;
    console.log('[WhatsAppMicroservice] Socket.io server mounted successfully.');

    this.io.on('connection', (socket) => {
      socket.on('join_tenant', (tenantId: string) => {
        const cleanTenant = this.sanitizeTenantId(tenantId);
        socket.join(`tenant:${cleanTenant}`);
        const session = this.sessions.get(cleanTenant);
        if (session) {
          socket.emit('connection_status', {
            tenantId: cleanTenant,
            status: session.status,
            phone: session.phone,
            verifiedName: session.verifiedName
          });
          if (session.pairingCode) {
            socket.emit('pairing_code_stream', {
              tenantId: cleanTenant,
              code: session.pairingCode.match(/.{1,4}/g)?.join('-') || session.pairingCode
            });
          }
          if (session.qrDataUrl) {
            socket.emit('qr_stream', {
              tenantId: cleanTenant,
              qr: session.qrCode,
              qrDataUrl: session.qrDataUrl
            });
          }
        }
      });

      socket.on('request_pairing_code', async (data: { tenantId: string; phoneNumber: string }) => {
        try {
          await this.initializeInstance(data.tenantId, 'PAIRING_CODE', data.phoneNumber);
        } catch (err: any) {
          socket.emit('connection_error', { tenantId: data.tenantId, error: err.message });
        }
      });

      socket.on('request_qr_code', async (data: { tenantId: string }) => {
        try {
          await this.initializeInstance(data.tenantId, 'QR');
        } catch (err: any) {
          socket.emit('connection_error', { tenantId: data.tenantId, error: err.message });
        }
      });

      socket.on('disconnect_instance', async (data: { tenantId: string }) => {
        try {
          await this.disconnect(data.tenantId);
        } catch (err: any) {
          socket.emit('connection_error', { tenantId: data.tenantId, error: err.message });
        }
      });
    });
  }

  private sanitizeTenantId(tenantId: string): string {
    return (tenantId || 'store_aura_main').replace(/[^a-zA-Z0-9_-]/g, '_');
  }

  public getSession(tenantId: string): WhatsAppInstanceSession | undefined {
    return this.sessions.get(this.sanitizeTenantId(tenantId));
  }

  public setCatalog(tenantId: string, storeName: string, currencySymbol: string, products: Product[]): void {
    const cleanId = this.sanitizeTenantId(tenantId);
    this.tenantCatalogs.set(cleanId, { storeName, currencySymbol, products });
  }

  /**
   * Initializes or re-initializes a multi-tenant WhatsApp instance.
   * Uses database-backed auth state to prevent disk file explosions.
   */
  public async initializeInstance(
    tenantId: string, 
    authMethod: 'QR' | 'PAIRING_CODE' = 'PAIRING_CODE', 
    phoneInput?: string
  ): Promise<{ status: WhatsAppLifecycleStatus; pairingCode?: string; qrCode?: string; qrDataUrl?: string }> {
    const cleanId = this.sanitizeTenantId(tenantId);
    console.log(`[WhatsAppMicroservice:${cleanId}] Initializing instance (Method: ${authMethod}, Phone: ${phoneInput || 'N/A'})...`);

    // Clean up existing socket without wiping database credentials
    const existing = this.sessions.get(cleanId);
    if (existing?.sock) {
      try {
        existing.sock.ev.removeAllListeners('connection.update');
        existing.sock.ev.removeAllListeners('creds.update');
        existing.sock.ev.removeAllListeners('messages.upsert');
        existing.sock.end(undefined);
      } catch {}
    }

    // Load Supabase PostgreSQL / Database-backed Authentication State (No local JSON folders!)
    const hasSupabase = !!(process.env.VITE_SUPABASE_URL && !process.env.VITE_SUPABASE_URL.includes('your-project'));
    const { state, saveCreds } = hasSupabase 
      ? await useSupabaseAuthState(cleanId) 
      : await useDatabaseAuthState(cleanId);
    const { version } = await fetchLatestBaileysVersion();

    const session: WhatsAppInstanceSession = existing || {
      tenantId: cleanId,
      sock: null,
      status: 'INITIALIZING',
      authMethod,
      phone: phoneInput || null,
      reconnectAttempts: 0,
      messages: []
    };

    session.authMethod = authMethod;
    if (phoneInput) session.phone = phoneInput;
    session.status = 'INITIALIZING';
    this.sessions.set(cleanId, session);
    this.emitStatus(cleanId, 'INITIALIZING');

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: this.logger,
      browser: ['Aura Commerce SaaS', 'Chrome', '1.0.0'],
      syncFullHistory: false,
      generateHighQualityLinkPreview: true,
      markOnlineOnConnect: true
    });

    session.sock = sock;

    // Handle credentials updates
    sock.ev.on('creds.update', async () => {
      await saveCreds();
    });

    // Connection lifecycle management
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      // Real-time QR Code streaming
      if (qr && authMethod === 'QR') {
        session.qrCode = qr;
        session.status = 'QR_RECEIVED';
        try {
          const dataUrl = await QRCode.toDataURL(qr);
          session.qrDataUrl = dataUrl;
          this.emitQr(cleanId, qr, dataUrl);
          this.emitStatus(cleanId, 'QR_RECEIVED');
        } catch (err) {
          console.error(`[WhatsAppMicroservice:${cleanId}] Error creating QR DataURL:`, err);
        }
      }

      if (connection === 'connecting') {
        session.status = 'CONNECTING';
        this.emitStatus(cleanId, 'CONNECTING');
      }

      if (connection === 'open') {
        session.status = 'CONNECTED';
        session.reconnectAttempts = 0;
        session.lastConnectedAt = new Date().toISOString();
        if (sock.user?.id) {
          const cleanPhone = sock.user.id.split(':')[0].replace(/\D/g, '');
          session.phone = `+${cleanPhone}`;
          session.verifiedName = sock.user.name || 'WhatsApp Business';
        }

        console.log(`[WhatsAppMicroservice:${cleanId}] Connection established! Linked Phone: ${session.phone}`);
        this.emitStatus(cleanId, 'CONNECTED', session.phone, session.verifiedName);

        // Auto-sync contacts immediately upon connection
        this.autoSyncLinkedAccountContacts(cleanId);
      }

      if (connection === 'close') {
        const reason = (lastDisconnect?.error as Boom)?.output?.statusCode ?? 
                       (lastDisconnect?.error as any)?.statusCode;
        const structuralLogout = reason === DisconnectReason.loggedOut || reason === 401;

        console.log(`[WhatsAppMicroservice:${cleanId}] Connection closed (Reason Code: ${reason}). Structural Logout: ${structuralLogout}`);

        if (!structuralLogout) {
          // Automatic Exponential Backoff Reconnect Pipeline
          session.reconnectAttempts++;
          const backoffDelay = Math.min(1000 * Math.pow(1.5, session.reconnectAttempts) + Math.random() * 1000, 30000);
          console.log(`[WhatsAppMicroservice:${cleanId}] Temporary dropout. Scheduling backoff reconnect in ${Math.round(backoffDelay)}ms (Attempt ${session.reconnectAttempts})...`);
          
          if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
          session.reconnectTimer = setTimeout(() => {
            this.initializeInstance(cleanId, session.authMethod, session.phone || undefined);
          }, backoffDelay);
        } else {
          // Structural logout: purge database records and notify frontend
          console.log(`[WhatsAppMicroservice:${cleanId}] User logged out from WhatsApp. Purging database session.`);
          await clearDatabaseAuthState(cleanId);
          await clearSupabaseAuthState(cleanId);
          session.status = 'DISCONNECTED';
          session.phone = null;
          session.qrCode = null;
          session.qrDataUrl = null;
          session.pairingCode = null;
          this.emitStatus(cleanId, 'DISCONNECTED');
        }
      }
    });

    // Handle inbound customer inquiries and automated dialogue
    sock.ev.on('messages.upsert', async (msgUpdate) => {
      await this.handleIncomingMessages(cleanId, msgUpdate.messages);
    });

    // Non-blocking asynchronous contact map synchronization
    sock.ev.on('contacts.upsert', (newContacts) => {
      this.handleBackgroundContactUpsert(cleanId, newContacts);
    });

    // Handle Pairing Code Stream if requested
    if (authMethod === 'PAIRING_CODE' && phoneInput && !sock.authState.creds.registered) {
      const cleanPhone = phoneInput.replace(/\D/g, '');
      session.status = 'CONNECTING';
      this.emitStatus(cleanId, 'CONNECTING');

      // Allow socket handshake to settle before requesting code
      setTimeout(async () => {
        try {
          if (!sock.authState.creds.registered) {
            console.log(`[WhatsAppMicroservice:${cleanId}] Requesting pairing code for phone: ${cleanPhone}`);
            const code = await sock.requestPairingCode(cleanPhone);
            session.pairingCode = code;
            session.status = 'PAIRING_CODE_RECEIVED';
            const formatted = code.match(/.{1,4}/g)?.join('-') || code;
            console.log(`[WhatsAppMicroservice:${cleanId}] Generated Pairing Code: ${formatted}`);
            this.emitPairingCode(cleanId, formatted);
            this.emitStatus(cleanId, 'PAIRING_CODE_RECEIVED');
          }
        } catch (err: any) {
          console.error(`[WhatsAppMicroservice:${cleanId}] Failed requesting pairing code:`, err);
          session.lastError = err.message;
          this.emitStatus(cleanId, 'DISCONNECTED');
        }
      }, 3000);
    }

    return {
      status: session.status,
      pairingCode: session.pairingCode || undefined,
      qrCode: session.qrCode || undefined,
      qrDataUrl: session.qrDataUrl || undefined
    };
  }

  /**
   * Inbound customer message router & automated store assistant.
   */
  private async handleIncomingMessages(tenantId: string, messages: WAMessage[]): Promise<void> {
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const remoteJid = msg.key.remoteJid;
      if (!remoteJid || remoteJid.includes('@broadcast') || remoteJid.includes('status@broadcast')) continue;

      const text = msg.message.conversation || 
                   msg.message.extendedTextMessage?.text || 
                   msg.message.imageMessage?.caption || 
                   '';

      if (!text.trim()) continue;

      const customerPhone = `+${remoteJid.split('@')[0]}`;
      const customerName = msg.pushName || `Customer (${customerPhone.slice(-4)})`;

      console.log(`[WhatsAppMicroservice:${tenantId}] Inbound message from ${customerName} (${customerPhone}): "${text}"`);

      // Store message in session conversation buffer
      const session = this.sessions.get(tenantId);
      if (session) {
        session.messages.push({
          id: msg.key.id || `msg_${Date.now()}`,
          from: customerPhone,
          body: text,
          timestamp: Date.now(),
          isOutgoing: false
        });
      }

      // Record lead in CRM store
      crmLeadStore.autoCaptureInbound(tenantId, customerPhone, customerName, text);

      // Context-aware inventory routing
      const catalogInfo = this.tenantCatalogs.get(tenantId);
      const products = catalogInfo?.products || [];
      const storeName = catalogInfo?.storeName || 'Aura Store';
      const currencySymbol = catalogInfo?.currencySymbol || '$';

      // Process automated order/recommendation engine
      const botResponse = whatsappOrderEngine.processMessage(
        tenantId,
        customerPhone,
        customerName,
        text,
        products,
        storeName
      );

      // Check if response contains a product highlight that should be sent with pristine CDN image
      if (botResponse.productCard) {
        await this.sendProductCard(tenantId, remoteJid, botResponse.productCard.product, botResponse.productCard.caption, currencySymbol);
      } else {
        await this.sendMessage(tenantId, remoteJid, botResponse.replyText);
      }
    }
  }

  /**
   * Dispatches a structured product card payload with a guaranteed public HTTPS CDN URL.
   */
  public async sendProductCard(
    tenantId: string, 
    targetJid: string, 
    product: Product, 
    customCaption?: string,
    currencySymbol = '$'
  ): Promise<any> {
    const publicImageUrl = ensurePublicCdnUrl(product.image);
    const caption = customCaption || 
      `🛍️ *${product.name}*\n\n📌 ${product.description}\n\n💰 *Price:* ${currencySymbol}${product.price.toLocaleString()}\n🔢 *In Stock:* ${product.stock > 0 ? '✅ Available' : '❌ Out of Stock'}\n\n👉 Reply with *BUY ${product.id}* to instantly checkout!`;

    const productPayload = {
      image: { url: publicImageUrl },
      caption
    };

    return messageQueue.enqueue(tenantId, targetJid, productPayload, { priority: 'high' });
  }

  /**
   * Queues an outgoing text message through the rate-limited anti-ban queue.
   */
  public async sendMessage(tenantId: string, targetJid: string, text: string): Promise<any> {
    const jid = targetJid.includes('@') ? targetJid : `${targetJid.replace(/\D/g, '')}@s.whatsapp.net`;
    const payload = { text };
    return messageQueue.enqueue(tenantId, jid, payload, { priority: 'normal' });
  }

  /**
   * Internal worker execution handler called by the MessageQueue after pacing delay.
   */
  private async dispatchRawMessage(tenantId: string, targetJid: string, payload: any): Promise<any> {
    const cleanId = this.sanitizeTenantId(tenantId);
    const session = this.sessions.get(cleanId);

    if (!session || !session.sock || session.status !== 'CONNECTED') {
      throw new Error(`Instance for tenant ${cleanId} is not connected to WhatsApp`);
    }

    const jid = targetJid.includes('@') ? targetJid : `${targetJid.replace(/\D/g, '')}@s.whatsapp.net`;
    const result = await session.sock.sendMessage(jid, payload);

    if (session) {
      session.messages.push({
        id: result?.key?.id || `out_${Date.now()}`,
        from: 'me',
        body: payload.text || payload.caption || '[Media Message]',
        timestamp: Date.now(),
        isOutgoing: true,
        mediaUrl: payload.image?.url
      });
    }

    return result;
  }

  public autoSyncLinkedAccountContacts(tenantId: string): { success: boolean; syncedCount: number; totalContacts: number; contacts: any[] } {
    const cleanId = this.sanitizeTenantId(tenantId);
    console.log(`[WhatsAppMicroservice:${cleanId}] Running auto-sync contacts for linked account...`);
    const result = crmLeadStore.syncWhatsAppBusinessApi(cleanId);
    return {
      success: true,
      syncedCount: result.syncedCount,
      totalContacts: result.contacts.length,
      contacts: result.contacts
    };
  }

  public async disconnect(tenantId: string): Promise<void> {
    const cleanId = this.sanitizeTenantId(tenantId);
    const session = this.sessions.get(cleanId);

    if (session?.sock) {
      try {
        await session.sock.logout();
      } catch {}
      try {
        session.sock.end(undefined);
      } catch {}
    }

    await clearDatabaseAuthState(cleanId);
    await clearSupabaseAuthState(cleanId);
    messageQueue.clearQueue(cleanId);

    if (session) {
      session.status = 'DISCONNECTED';
      session.phone = null;
      session.qrCode = null;
      session.qrDataUrl = null;
      session.pairingCode = null;
    }

    this.emitStatus(cleanId, 'DISCONNECTED');
  }

  /**
   * Non-blocking asynchronous contact map synchronization worker.
   * Chunks large contact lists into batches of 100 and yields event loop execution
   * via setImmediate() so server never freezes or hangs dashboard UI.
   */
  public handleBackgroundContactUpsert(tenantId: string, contactsList: any[]): void {
    const cleanId = this.sanitizeTenantId(tenantId);
    if (!contactsList || contactsList.length === 0) return;

    const BATCH_SIZE = 100;
    const total = contactsList.length;

    const processNextBatch = (startIndex: number) => {
      const batch = contactsList.slice(startIndex, startIndex + BATCH_SIZE);
      if (batch.length === 0) {
        const payload = {
          tenantId: cleanId,
          syncedCount: total,
          totalContacts: crmLeadStore.getTenantLeads(cleanId).length,
          timestamp: new Date().toISOString()
        };
        if (this.io) {
          this.io.to(`tenant:${cleanId}`).emit('contacts_synced', payload);
          this.io.emit('contacts_synced', payload);
        }
        return;
      }

      const supabaseRows: Array<{ store_id: string; jid: string; name: string; phone: string }> = [];

      for (const c of batch) {
        const jid = c.id || c.jid || '';
        const phone = jid.split('@')[0] ? `+${jid.split('@')[0].replace(/\D/g, '')}` : '';
        const name = c.name || c.notify || c.verifiedName || `Contact (${phone.slice(-4) || 'WA'})`;
        if (phone) {
          crmLeadStore.addLead(cleanId, {
            name,
            phone,
            email: '',
            stage: 'lead',
            notes: 'Auto-synced via non-blocking background worker',
            tags: ['Synced Contact', 'WhatsApp Device']
          });

          supabaseRows.push({
            store_id: cleanId,
            jid,
            name,
            phone
          });
        }
      }

      // If Supabase is connected, upsert batch
      if (supabase && supabaseRows.length > 0) {
        supabase.from('contacts').upsert(supabaseRows, { onConflict: 'store_id,jid' }).then(() => {}).catch(() => {});
      }

      // Yield event loop to prevent event loop starvation
      setImmediate(() => {
        processNextBatch(startIndex + BATCH_SIZE);
      });
    };

    setImmediate(() => {
      processNextBatch(0);
    });
  }

  // Socket.io broadcasting helpers - Dual delivery (Tenant Room + Immediate Global Broadcast)
  private emitStatus(tenantId: string, status: WhatsAppLifecycleStatus, phone?: string | null, verifiedName?: string | null): void {
    if (this.io) {
      const payload = {
        tenantId,
        status,
        phone,
        verifiedName,
        timestamp: Date.now()
      };
      this.io.to(`tenant:${tenantId}`).emit('connection_status', payload);
      this.io.emit('connection_status', payload);
    }
  }

  private emitPairingCode(tenantId: string, code: string): void {
    if (this.io) {
      const payload = { tenantId, code };
      this.io.to(`tenant:${tenantId}`).emit('pairing_code_stream', payload);
      this.io.emit('pairing_code_stream', payload);
    }
  }

  private emitQr(tenantId: string, qr: string, qrDataUrl: string): void {
    if (this.io) {
      const payload = { tenantId, qr, qrDataUrl };
      this.io.to(`tenant:${tenantId}`).emit('qr_stream', payload);
      this.io.emit('qr_stream', payload);
    }
  }
}

export const whatsappMicroservice = new WhatsAppMicroservice();
