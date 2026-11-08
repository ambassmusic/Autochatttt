import fs from 'fs';
import path from 'path';
import QRCode from 'qrcode';
import pino from 'pino';
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  WASocket,
  Browsers,
  AnyMessageContent,
  MiscMessageGenerationOptions
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { whatsappOrderEngine } from './whatsappOrderEngine.js';
import { sessionStore, AuthMethod, ConnectionStatus, DisconnectCategory } from './sessionStore.js';
import { crmLeadStore } from './crmLeadStore.js';
import { AntiBanQueueController } from './antiBanQueue.js';
import { ensurePublicCdnUrl } from './whatsappMicroservice.js';
import { MULTI_INDUSTRY_PRESETS, INITIAL_PRODUCTS } from '../data/initialData.js';

export interface WhatsAppMessage {
  id: string;
  from: string;
  to: string;
  text: string;
  timestamp: string;
  direction: 'inbound' | 'outbound';
  status: 'sent' | 'delivered' | 'read' | 'failed' | 'received';
  pushName?: string;
  source: 'baileys_embedded';
  antiBanDelayMs?: number;
}

export interface TenantSession {
  tenantId: string;
  instanceName: string;
  engine: 'baileys_embedded';
  status: 'disconnected' | 'connecting' | 'qrcode' | 'connected' | 'reconnecting' | 'error';
  authMethod: AuthMethod;
  qrCode: string | null;
  qrRaw: string | null;
  qrExpiresAt: number | null;
  pairingCode: string | null;
  pairingExpiresAt: number | null;
  isPairingHandshake: boolean;
  phone: string | null;
  verifiedName: string | null;
  connectedAt: string | null;
  lastPingMs: number;
  lastError: string | null;
  messages: WhatsAppMessage[];
  sock?: WASocket;
  storagePath: string;
  reconnectAttempts: number;
  reconnectTimer?: NodeJS.Timeout | null;
}

export class WhatsAppManager {
  private sessions = new Map<string, TenantSession>();
  private tenantCatalogs = new Map<string, { storeName: string; products: any[]; settings?: any }>();
  private sessionBaseDir = path.resolve(process.cwd(), 'storage', 'sessions');
  private antiBanQueue: AntiBanQueueController;

  constructor() {
    this.ensureStorageRoot();
    this.antiBanQueue = new AntiBanQueueController((userId) => {
      const sess = this.sessions.get(userId);
      return sess?.sock;
    });

    // Pre-seed default catalogs for tenants so automated bot never responds empty
    const defaultCatalog = {
      storeName: 'AURA Store & Tools',
      products: [
        {
          id: 'prod_linen_01',
          name: 'Artisanal Linen Overshirt',
          category: 'Apparel',
          industry: 'fashion',
          price: 118,
          description: 'Tailored relaxed-fit 100% Normandy flax linen with natural mother-of-pearl buttons. Breathable, pre-washed for soft drape.',
          stock: 14,
          productType: 'physical',
          featured: true,
          sizes: ['S', 'M', 'L', 'XL'],
          colors: ['Oat Sand', 'Chalk White'],
          tags: ['linen', 'shirt', 'overshirt', 'summer', 'apparel', 'bestseller']
        },
        {
          id: 'prod_weekender_02',
          name: 'Full-Grain Cognac Leather Weekender',
          category: 'Leather Goods',
          industry: 'fashion',
          price: 285,
          description: 'Handcrafted vegetable-tanned Italian leather with solid brass hardware, reinforced base, and detachable shoulder strap.',
          stock: 7,
          productType: 'physical',
          featured: true,
          sizes: ['One Size (45L)'],
          colors: ['Cognac Brown', 'Dark Espresso'],
          tags: ['leather', 'bag', 'weekender', 'travel', 'duffle', 'luggage']
        },
        {
          id: 'prod_sneakers_03',
          name: 'Minimalist Chalk Low-Top Sneakers',
          category: 'Footwear',
          industry: 'fashion',
          price: 165,
          description: 'Buttery calfskin leather upper paired with durable Margom rubber sole and memory-foam arch support insoles.',
          stock: 18,
          productType: 'physical',
          featured: true,
          sizes: ['40', '41', '42', '43', '44', '45'],
          colors: ['Chalk White', 'Monochrome Gray'],
          tags: ['sneakers', 'shoes', 'footwear', 'leather', 'chalk', 'trainers']
        },
        {
          id: 'prod_lookbook_digital',
          name: 'Atelier Capsule Lookbook & Masterclass',
          category: 'Digital Guides',
          industry: 'fashion',
          price: 29,
          description: 'Complete 84-page wardrobe capsule architecture guide (PDF) + 4K video masterclass. Sent instantly upon payment.',
          stock: 999,
          productType: 'digital',
          featured: true,
          sizes: ['Digital Access'],
          tags: ['lookbook', 'guide', 'masterclass', 'digital', 'capsule']
        }
      ]
    };
    this.tenantCatalogs.set('store_aura_main', defaultCatalog);
    this.tenantCatalogs.set('default_store', defaultCatalog);
  }

  private catalogDir = path.resolve(process.cwd(), 'storage', 'database', 'catalogs');

  private ensureStorageRoot(): void {
    if (!fs.existsSync(this.sessionBaseDir)) {
      try {
        fs.mkdirSync(this.sessionBaseDir, { recursive: true });
      } catch (err) {
        console.error('[WhatsAppManager] Failed to create storage/sessions root:', err);
      }
    }
    if (!fs.existsSync(this.catalogDir)) {
      try {
        fs.mkdirSync(this.catalogDir, { recursive: true });
      } catch {}
    }
  }

  public getTenantCatalog(tenantId: string): { storeName: string; products: any[]; settings?: any } {
    const cleanId = this.sanitizeUserId(tenantId);
    if (this.tenantCatalogs.has(cleanId)) {
      return this.tenantCatalogs.get(cleanId)!;
    }

    const file = path.join(this.catalogDir, `${cleanId}.json`);
    if (fs.existsSync(file)) {
      try {
        const raw = fs.readFileSync(file, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.products)) {
          this.tenantCatalogs.set(cleanId, parsed);
          return parsed;
        }
      } catch (err) {
        console.warn(`[WhatsAppManager] Error reading catalog for ${cleanId}:`, err);
      }
    }

    // Default isolated catalog per store with industry detection
    const isFood = cleanId.includes('food') || 
      cleanId.includes('tavola') || 
      cleanId.includes('kitchen') || 
      cleanId.includes('bali') || 
      cleanId.includes('dining') || 
      cleanId.includes('pizza') ||
      cleanId.includes('restaurant');

    const foodProducts = MULTI_INDUSTRY_PRESETS[1]?.products || [];
    const fashionProducts = MULTI_INDUSTRY_PRESETS[0]?.products || INITIAL_PRODUCTS;

    const fallback = {
      storeName: isFood ? 'Tavola Artisan Kitchen & Delivery' : (cleanId === 'store_aura_main' ? 'AURA Store & Tools' : 'Our WhatsApp Store'),
      products: isFood ? foodProducts : (cleanId === 'store_aura_main' ? fashionProducts : foodProducts),
      settings: {
        industry: isFood ? 'food' : 'fashion',
        storeTagline: isFood ? 'Wood-fired pizza, fresh pastas & grilled seafood' : 'Tailored sustainable fashion & bespoke leathercraft'
      }
    };

    this.tenantCatalogs.set(cleanId, fallback);
    return fallback;
    return fallback;
  }

  public setTenantCatalog(tenantId: string, storeName: string, products: any[], settings?: any): void {
    const cleanId = this.sanitizeUserId(tenantId);
    const catalogData = {
      storeName: storeName || 'Our WhatsApp Store',
      products: Array.isArray(products) ? products : [],
      settings: settings || null
    };
    this.tenantCatalogs.set(cleanId, catalogData);

    try {
      this.ensureStorageRoot();
      const file = path.join(this.catalogDir, `${cleanId}.json`);
      fs.writeFileSync(file, JSON.stringify(catalogData, null, 2), 'utf-8');
      console.log(`[WhatsAppManager] Saved isolated catalog (${catalogData.products.length} products) for tenant ${cleanId}`);
    } catch (err) {
      console.warn(`[WhatsAppManager] Failed to persist catalog for ${cleanId}:`, err);
    }
  }

  /**
   * Automatically scans companion session storage for synced WhatsApp Business contacts
   * and populates them into CRM Leads.
   */
  public syncContactsFromDisk(tenantId: string): { count: number } {
    const cleanId = this.sanitizeUserId(tenantId);
    const sessionDir = this.getUserStoragePath(cleanId);
    if (!fs.existsSync(sessionDir)) return { count: 0 };

    const contactsToSync: Array<{ phone: string; name?: string }> = [];
    try {
      const files = fs.readdirSync(sessionDir);
      for (const f of files) {
        if (f.startsWith('lid-mapping-') && !f.includes('_reverse')) {
          const numPart = f.replace('lid-mapping-', '').replace('.json', '');
          if (/^\d{8,15}$/.test(numPart)) {
            contactsToSync.push({ phone: numPart, name: `WhatsApp Contact (+${numPart.slice(-4)})` });
          }
        } else if (f.startsWith('device-list-')) {
          const numPart = f.replace('device-list-', '').replace('.json', '');
          if (/^\d{8,15}$/.test(numPart)) {
            contactsToSync.push({ phone: numPart, name: `WhatsApp Business Contact (+${numPart.slice(-4)})` });
          }
        }
      }
    } catch (err) {
      console.warn(`[WhatsAppManager:${cleanId}] Error reading session storage for contacts:`, err);
    }

    if (contactsToSync.length > 0) {
      const result = crmLeadStore.syncWhatsAppContacts(cleanId, contactsToSync);
      console.log(`[WhatsAppManager:${cleanId}] Synced ${result.syncedCount} contacts from companion storage into CRM.`);
      return { count: result.syncedCount };
    }
    return { count: 0 };
  }

  public sanitizeUserId(userId: string): string {
    return (userId || 'default_store').replace(/[^a-zA-Z0-9_-]/g, '_');
  }

  public getUserStoragePath(userId: string): string {
    const cleanId = this.sanitizeUserId(userId);
    return path.join(this.sessionBaseDir, cleanId);
  }

  public getOrCreateSession(userId: string, instanceName?: string): TenantSession {
    const cleanId = this.sanitizeUserId(userId);
    const cleanInstance = instanceName || `omni_${cleanId}`;
    const storagePath = this.getUserStoragePath(cleanId);

    let session = this.sessions.get(cleanId);
    if (!session) {
      let isRegistered = false;
      let registeredPhone: string | null = null;
      let registeredName: string | null = null;

      const credsFile = path.join(storagePath, 'creds.json');
      if (fs.existsSync(credsFile)) {
        try {
          const raw = fs.readFileSync(credsFile, 'utf-8');
          const parsed = JSON.parse(raw);
          if (parsed && parsed.registered) {
            isRegistered = true;
            if (parsed.me?.id) {
              const rawId = parsed.me.id.split(':')[0];
              registeredPhone = rawId.startsWith('+') ? rawId : `+${rawId}`;
            }
            if (parsed.me?.name) {
              registeredName = parsed.me.name;
            }
          }
        } catch {}
      }

      session = {
        tenantId: cleanId,
        instanceName: cleanInstance,
        engine: 'baileys_embedded',
        status: isRegistered ? 'connecting' : 'disconnected',
        authMethod: 'PAIRING_CODE',
        qrCode: null,
        qrRaw: null,
        qrExpiresAt: null,
        pairingCode: null,
        pairingExpiresAt: null,
        isPairingHandshake: false,
        phone: registeredPhone,
        verifiedName: registeredName,
        connectedAt: isRegistered ? new Date().toISOString() : null,
        lastPingMs: 24,
        lastError: null,
        messages: [],
        storagePath,
        reconnectAttempts: 0
      };
      this.sessions.set(cleanId, session);

      if (isRegistered) {
        setImmediate(() => {
          this.resumeExistingSession(cleanId, registeredPhone);
        });
      }
    }
    return session;
  }

  public getSession(userId: string): TenantSession | undefined {
    const cleanId = this.sanitizeUserId(userId);
    return this.sessions.get(cleanId);
  }

  public getAllSessions(): Array<Omit<TenantSession, 'sock'>> {
    return Array.from(this.sessions.values()).map(s => {
      const { sock, ...rest } = s;
      return rest;
    });
  }

  public getAntiBanMetrics(userId: string) {
    const cleanId = this.sanitizeUserId(userId);
    return this.antiBanQueue.getQueueMetrics(cleanId);
  }

  /* ========================================================================= */
  /* MODULE 2: DUAL AUTH MANAGER & AUTOMATIC DISCONNECTION HANDLING            */
  /* ========================================================================= */

  /**
   * Safely closes an active socket and clears any pending reconnect timers,
   * removing all event listeners to prevent zombie reconnect loops.
   */
  private safeCloseSocket(session: TenantSession): void {
    if (session.reconnectTimer) {
      clearTimeout(session.reconnectTimer);
      session.reconnectTimer = null;
    }
    if (session.sock) {
      const oldSock = session.sock;
      session.sock = undefined;
      try {
        oldSock.ev.removeAllListeners('connection.update');
        oldSock.ev.removeAllListeners('creds.update');
        oldSock.ev.removeAllListeners('messages.upsert');
        oldSock.end(undefined);
      } catch {}
    }
  }

  /**
   * Connects a user's multi-tenant WhatsApp session using
   * either QR Code scanning or Phone Number Pairing Code.
   */
  public async connectUserSession(
    userId: string,
    authMethod: AuthMethod,
    phoneNumber?: string,
    options?: { forceNewCode?: boolean }
  ): Promise<{
    success: boolean;
    status: string;
    authMethod: AuthMethod;
    qrCode?: string | null;
    pairingCode?: string | null;
    expiresInSeconds?: number;
    pairingExpiresInSeconds?: number;
    phone?: string | null;
    error?: string | null;
    sessionId?: string;
  }> {
    const cleanId = this.sanitizeUserId(userId);
    const session = this.getOrCreateSession(cleanId);
    session.authMethod = authMethod;

    // Check if session is already active and healthy
    if (session.status === 'connected' && session.phone && session.sock) {
      console.log(`[WhatsAppManager] User session ${cleanId} is already connected with phone ${session.phone}`);
      const dbRow = await sessionStore.getSession(cleanId);
      return {
        success: true,
        status: 'connected',
        authMethod,
        phone: session.phone,
        sessionId: dbRow?.id
      };
    }

    const userStorageDir = session.storagePath;

    // Check if session has registered credentials on disk (e.g. phone already linked)
    const credsFile = path.join(userStorageDir, 'creds.json');
    if (!options?.forceNewCode && fs.existsSync(credsFile)) {
      try {
        const raw = fs.readFileSync(credsFile, 'utf-8');
        const creds = JSON.parse(raw);
        if (creds && creds.registered) {
          const registeredPhone = creds.me?.id ? `+${creds.me.id.split(':')[0]}` : session.phone;
          console.log(`[WhatsAppManager:${cleanId}] Found registered credentials for phone ${registeredPhone}. Resuming session...`);
          await this.resumeExistingSession(cleanId, registeredPhone);
          const dbRow = await sessionStore.getSession(cleanId);
          return {
            success: true,
            status: 'connected',
            authMethod,
            phone: registeredPhone || session.phone,
            sessionId: dbRow?.id
          };
        }
      } catch (err) {
        console.warn(`[WhatsAppManager:${cleanId}] Could not inspect creds.json:`, err);
      }
    }

    // Clean existing socket and clear any pending timers safely
    this.safeCloseSocket(session);

    // Normalize phone number for PAIRING_CODE
    let cleanNumber = '';
    if (phoneNumber) {
      cleanNumber = phoneNumber.replace(/\D/g, '');
      if (cleanNumber.startsWith('0') && cleanNumber.length === 11) {
        cleanNumber = '234' + cleanNumber.slice(1);
      } else if (cleanNumber.startsWith('2340') && cleanNumber.length === 14) {
        cleanNumber = '234' + cleanNumber.slice(4);
      }
    }

    if (authMethod === 'PAIRING_CODE') {
      if (!cleanNumber || cleanNumber.length < 9) {
        return {
          success: false,
          status: 'error',
          authMethod,
          error: 'Please provide a valid WhatsApp phone number with country code (e.g., +234 812 345 6789)'
        };
      }
      session.phone = `+${cleanNumber}`;
    }

    // Always reset storage directory if not registered or if fresh code requested
    if (fs.existsSync(userStorageDir)) {
      try {
        fs.rmSync(userStorageDir, { recursive: true, force: true });
      } catch (e) {
        console.warn('Could not reset user storage directory:', e);
      }
    }
    fs.mkdirSync(userStorageDir, { recursive: true });
    session.pairingCode = null;
    session.pairingExpiresAt = null;
    session.isPairingHandshake = false;
    session.reconnectAttempts = 0;

    // Track state in database schema as INITIALIZING
    const dbRecord = await sessionStore.upsertSession({
      userId: cleanId,
      authMethod,
      phoneNumber: session.phone,
      connectionStatus: 'INITIALIZING',
      storagePath: userStorageDir
    });

    session.status = 'connecting';
    session.lastError = null;

    try {
      const { state, saveCreds } = await useMultiFileAuthState(userStorageDir);
      const { version } = await fetchLatestBaileysVersion();
      const logger = pino({ level: 'silent' });

      // Use standard Desktop Chrome companion identity recognized by WhatsApp
      const sock = makeWASocket({
        version,
        logger,
        printQRInTerminal: false,
        auth: state,
        browser: Browsers.macOS('Chrome'),
        syncFullHistory: false,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 25000,
        emitOwnEvents: false
      });

      session.sock = sock;
      session.engine = 'baileys_embedded';

      // 1. Dynamic credentials listener
      sock.ev.on('creds.update', async () => {
        try {
          await saveCreds();
        } catch (saveErr) {
          console.error(`[WhatsAppManager:${cleanId}] Error saving credentials:`, saveErr);
        }
      });

      // Hook incoming message pipeline & Anti-Ban automated responses
      this.attachMessageListener(sock, session);

      // =========================================================================
      // BRANCH A: PAIRING CODE GENERATION & HANDSHAKE
      // =========================================================================
      if (authMethod === 'PAIRING_CODE') {
        // Wait for WebSocket connection to open
        await sock.waitForSocketOpen();

        if (session.sock !== sock) {
          return {
            success: false,
            status: 'error',
            authMethod,
            error: 'Socket was replaced during initialization'
          };
        }

        // CRITICAL: Wait 2.5s for validateConnection to complete registration handshake (<pair-device> node)
        // If requestPairingCode is called before registration handshake completes, WhatsApp sends <failure reason='401' location='cln'/>
        // and rejects the code as dead on the mobile phone!
        console.log(`[WhatsAppManager:${cleanId}] Establishing registration handshake with WhatsApp servers...`);
        await new Promise(r => setTimeout(r, 2500));

        if (session.sock !== sock) {
          return {
            success: false,
            status: 'error',
            authMethod,
            error: 'Socket was replaced during handshake'
          };
        }

        console.log(`[WhatsAppManager:${cleanId}] Requesting genuine WhatsApp pairing code for +${cleanNumber}...`);
        const rawPairingCode = await sock.requestPairingCode(cleanNumber);
        console.log(`[WhatsAppManager:${cleanId}] Genuine Pairing Code officially registered on WhatsApp: ${rawPairingCode}`);

        const formattedCode = rawPairingCode.length === 8
          ? `${rawPairingCode.slice(0, 4)}-${rawPairingCode.slice(4)}`
          : rawPairingCode;

        session.pairingCode = formattedCode;
        session.pairingExpiresAt = Date.now() + 180000; // 3 minutes validity
        session.isPairingHandshake = true;
        session.status = 'connecting';

        await sessionStore.upsertSession({
          userId: cleanId,
          authMethod: 'PAIRING_CODE',
          phoneNumber: `+${cleanNumber}`,
          connectionStatus: 'INITIALIZING',
          storagePath: userStorageDir,
          pairingCode: formattedCode,
          pairingExpiresAt: new Date(session.pairingExpiresAt).toISOString()
        });

        // Set up connection.update to listen for phone linking and stream transitions
        sock.ev.on('connection.update', async (update) => {
          if (session.sock !== sock) return; // Stale socket guard
          const { connection, lastDisconnect } = update;

          if (connection === 'open') {
            session.status = 'connected';
            session.qrCode = null;
            session.qrRaw = null;
            session.qrExpiresAt = null;
            session.pairingCode = null;
            session.pairingExpiresAt = null;
            session.isPairingHandshake = false;
            session.connectedAt = new Date().toISOString();
            session.lastError = null;
            session.reconnectAttempts = 0;

            const userJid = sock.user?.id || '';
            const rawPhone = userJid.split(':')[0] || userJid.split('@')[0];
            session.phone = rawPhone ? (rawPhone.startsWith('+') ? rawPhone : `+${rawPhone}`) : (session.phone || `+${cleanNumber}`);
            session.verifiedName = sock.user?.name || 'OmniChat WhatsApp Store';

            console.log(`[WhatsAppManager:${cleanId}] WhatsApp connection OPEN & PAIRED! Phone: ${session.phone}`);

            await sessionStore.updateSessionStatus(cleanId, 'CONNECTED', {
              phoneNumber: session.phone,
              resetReconnect: true
            });
          }

          if (connection === 'close') {
            const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode ??
                               (lastDisconnect?.error as any)?.statusCode;
            const errorMsg = (lastDisconnect?.error as Error)?.message || 'Connection closed';

            // WhatsApp Stream Restart (515) occurs when the phone successfully enters the pairing code!
            if (statusCode === DisconnectReason.restartRequired || statusCode === 515) {
              console.log(`[WhatsAppManager:${cleanId}] Pairing code accepted by WhatsApp! Finalizing companion handshake (status 515)...`);
              session.status = 'connecting';
              if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
              session.reconnectTimer = setTimeout(() => {
                this.reconnectPairingSocket(cleanId, cleanNumber);
              }, 400);
              return;
            }

            console.log(`[WhatsAppManager:${cleanId}] Pairing socket close update. Status: ${statusCode} (${errorMsg}), isPairingHandshake: ${session.isPairingHandshake}`);

            const isPairingActive = session.isPairingHandshake && session.pairingExpiresAt && Date.now() < session.pairingExpiresAt;

            // In pairing handshake mode, 401 and 428 are normal while waiting for the phone user to type the code
            if (
              isPairingActive && (
                statusCode === 428 ||
                statusCode === DisconnectReason.connectionLost ||
                statusCode === DisconnectReason.loggedOut ||
                statusCode === 401
              )
            ) {
              console.log(`[WhatsAppManager:${cleanId}] Companion handshake waiting for phone entry (${statusCode}) — code active...`);
              session.status = 'connecting';
              if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
              session.reconnectTimer = setTimeout(() => {
                this.reconnectPairingSocket(cleanId, cleanNumber);
              }, 2000);
              return;
            }

            // Real hard logout (only when session was already registered or pairing code has expired)
            let isHardLogout = false;
            switch (statusCode) {
              case DisconnectReason.loggedOut: // 401
              case DisconnectReason.connectionReplaced: // 440
              case DisconnectReason.multideviceMismatch: // 411
              case DisconnectReason.forbidden: // 403
                isHardLogout = true;
                break;
            }

            if (isHardLogout) {
              console.warn(`[WhatsAppManager:${cleanId}] Hard logout (${statusCode}). Purging storage.`);
              session.status = 'disconnected';
              session.phone = null;
              session.pairingCode = null;
              session.isPairingHandshake = false;
              this.safeCloseSocket(session);
              this.deleteUserDirectory(cleanId);
              this.antiBanQueue.clearUserQueue(cleanId);
              await sessionStore.updateSessionStatus(cleanId, 'DISCONNECTED', {
                disconnectReason: `Hard logout (${statusCode}: ${errorMsg})`,
                disconnectCategory: 'HARD_LOGOUT'
              });
            } else {
              session.status = 'reconnecting';
              session.reconnectAttempts = (session.reconnectAttempts || 0) + 1;
              if (session.reconnectAttempts <= 5) {
                if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
                session.reconnectTimer = setTimeout(() => {
                  this.reconnectPairingSocket(cleanId, cleanNumber);
                }, Math.min(2000 * session.reconnectAttempts, 8000));
              }
            }
          }
        });

        // Resolve API call immediately with genuine pairing code
        return {
          success: true,
          status: 'connecting',
          authMethod: 'PAIRING_CODE',
          pairingCode: formattedCode,
          phone: `+${cleanNumber}`,
          pairingExpiresInSeconds: 180,
          sessionId: dbRecord.id
        };
      }

      // =========================================================================
      // BRANCH B: QR CODE SCAN
      // =========================================================================
      return new Promise<{
        success: boolean;
        status: string;
        authMethod: AuthMethod;
        qrCode?: string | null;
        pairingCode?: string | null;
        expiresInSeconds?: number;
        pairingExpiresInSeconds?: number;
        phone?: string | null;
        error?: string | null;
        sessionId?: string;
      }>((resolve) => {
        let isResolved = false;

        const connectionTimeout = setTimeout(() => {
          if (!isResolved) {
            isResolved = true;
            resolve({
              success: session.status === 'connected' || session.status === 'qrcode',
              status: session.status,
              authMethod: 'QR',
              qrCode: session.qrCode,
              expiresInSeconds: session.qrExpiresAt ? Math.max(0, Math.round((session.qrExpiresAt - Date.now()) / 1000)) : undefined,
              phone: session.phone,
              error: session.lastError,
              sessionId: dbRecord.id
            });
          }
        }, 15000);

        sock.ev.on('connection.update', async (update) => {
          if (session.sock !== sock) return; // Stale socket guard
          const { connection, lastDisconnect, qr } = update;

          if (qr) {
            try {
              const qrDataUrl = await QRCode.toDataURL(qr, {
                width: 320,
                margin: 2,
                color: {
                  dark: '#022c22',
                  light: '#ffffff'
                }
              });

              session.qrCode = qrDataUrl;
              session.qrRaw = qr;
              session.qrExpiresAt = Date.now() + 60000;
              session.status = 'qrcode';

              await sessionStore.upsertSession({
                userId: cleanId,
                authMethod: 'QR',
                connectionStatus: 'INITIALIZING',
                storagePath: userStorageDir,
                qrExpiresAt: new Date(session.qrExpiresAt).toISOString()
              });

              console.log(`[WhatsAppManager:${cleanId}] Generated QR code Data URL for scan`);

              if (!isResolved) {
                isResolved = true;
                clearTimeout(connectionTimeout);
                resolve({
                  success: true,
                  status: 'qrcode',
                  authMethod: 'QR',
                  qrCode: qrDataUrl,
                  expiresInSeconds: 60,
                  sessionId: dbRecord.id
                });
              }
            } catch (qrErr: any) {
              console.error(`[WhatsAppManager:${cleanId}] Error converting QR to Data URL:`, qrErr);
              session.lastError = 'Failed to generate QR Code visual';
            }
          }

          if (connection === 'open') {
            session.status = 'connected';
            session.qrCode = null;
            session.qrRaw = null;
            session.qrExpiresAt = null;
            session.pairingCode = null;
            session.pairingExpiresAt = null;
            session.isPairingHandshake = false;
            session.connectedAt = new Date().toISOString();
            session.lastError = null;
            session.reconnectAttempts = 0;

            const userJid = sock.user?.id || '';
            const rawPhone = userJid.split(':')[0] || userJid.split('@')[0];
            session.phone = rawPhone ? (rawPhone.startsWith('+') ? rawPhone : `+${rawPhone}`) : (session.phone || 'Connected Store Phone');
            session.verifiedName = sock.user?.name || 'OmniChat WhatsApp Store';

            console.log(`[WhatsAppManager:${cleanId}] WhatsApp connection OPEN! Phone: ${session.phone}`);

            await sessionStore.updateSessionStatus(cleanId, 'CONNECTED', {
              phoneNumber: session.phone,
              resetReconnect: true
            });

            if (!isResolved) {
              isResolved = true;
              clearTimeout(connectionTimeout);
              resolve({
                success: true,
                status: 'connected',
                authMethod: 'QR',
                phone: session.phone,
                sessionId: dbRecord.id
              });
            }
          }

          if (connection === 'close') {
            const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode ??
                               (lastDisconnect?.error as any)?.statusCode;
            const errorMsg = (lastDisconnect?.error as Error)?.message || 'Connection closed';

            console.log(`[WhatsAppManager:${cleanId}] Connection closed. Status code: ${statusCode} (${errorMsg})`);

            let isHardLogout = false;
            switch (statusCode) {
              case DisconnectReason.loggedOut:
              case DisconnectReason.connectionReplaced:
              case DisconnectReason.multideviceMismatch:
              case DisconnectReason.forbidden:
                isHardLogout = true;
                break;
            }

            if (isHardLogout) {
              session.status = 'disconnected';
              session.phone = null;
              session.qrCode = null;
              this.safeCloseSocket(session);
              this.deleteUserDirectory(cleanId);
              await sessionStore.updateSessionStatus(cleanId, 'DISCONNECTED');
            }

            if (!isResolved) {
              isResolved = true;
              clearTimeout(connectionTimeout);
              resolve({
                success: false,
                status: session.status,
                authMethod: 'QR',
                error: session.lastError || 'Socket connection closed',
                sessionId: dbRecord.id
              });
            }
          }
        });
      });
    } catch (err: any) {
      console.error(`[WhatsAppManager:${cleanId}] Fatal error in connectUserSession:`, err);
      session.status = 'error';
      session.lastError = err.message || 'Failed to initialize session';

      await sessionStore.updateSessionStatus(cleanId, 'DISCONNECTED', {
        disconnectReason: `Initialization fatal error: ${err.message}`
      });

      return {
        success: false,
        status: 'error',
        authMethod,
        error: session.lastError,
        sessionId: dbRecord.id
      };
    }
  }

  /**
   * Reconnects socket during Pairing Code exchange after WhatsApp Stream Restart (515/428)
   * or temporary disconnection WITHOUT re-requesting code or wiping credentials.
   */
  private async reconnectPairingSocket(userId: string, cleanPhone: string) {
    const cleanId = this.sanitizeUserId(userId);
    const session = this.getSession(cleanId);
    if (!session) return;

    try {
      const userStorageDir = session.storagePath;
      if (!fs.existsSync(userStorageDir)) return;

      this.safeCloseSocket(session);

      const { state, saveCreds } = await useMultiFileAuthState(userStorageDir);
      const { version } = await fetchLatestBaileysVersion();
      const logger = pino({ level: 'silent' });

      console.log(`[WhatsAppManager:${cleanId}] Re-binding socket with saved credentials for pairing...`);

      const sock = makeWASocket({
        version,
        logger,
        printQRInTerminal: false,
        auth: state,
        browser: Browsers.macOS('Chrome'),
        syncFullHistory: false,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 25000,
        emitOwnEvents: false
      });

      session.sock = sock;

      sock.ev.on('creds.update', saveCreds);

      sock.ev.on('connection.update', async (update) => {
        if (session.sock !== sock) return; // Stale socket guard
        const { connection, lastDisconnect } = update;

        if (connection === 'open') {
          session.status = 'connected';
          session.qrCode = null;
          session.qrRaw = null;
          session.pairingCode = null;
          session.pairingExpiresAt = null;
          session.isPairingHandshake = false;
          session.connectedAt = new Date().toISOString();
          session.lastError = null;

          const userJid = sock.user?.id || '';
          const rawPhone = userJid.split(':')[0] || userJid.split('@')[0];
          session.phone = rawPhone ? (rawPhone.startsWith('+') ? rawPhone : `+${rawPhone}`) : (cleanPhone ? `+${cleanPhone}` : 'Connected Store Phone');
          session.verifiedName = sock.user?.name || 'OmniChat WhatsApp Store';

          console.log(`[WhatsAppManager:${cleanId}] RECONNECT SUCCESS! Phone paired: ${session.phone}`);

          await sessionStore.updateSessionStatus(cleanId, 'CONNECTED', {
            phoneNumber: session.phone,
            resetReconnect: true
          });
        } else if (connection === 'close') {
          const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode ??
                             (lastDisconnect?.error as any)?.statusCode;

          if (statusCode === DisconnectReason.restartRequired || statusCode === 515) {
            console.log(`[WhatsAppManager:${cleanId}] Handshake stream restart (515) — finalizing connection...`);
            session.status = 'connecting';
            if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
            session.reconnectTimer = setTimeout(() => {
              this.reconnectPairingSocket(cleanId, cleanPhone);
            }, 600);
            return;
          }

          console.log(`[WhatsAppManager:${cleanId}] Reconnect socket closed with status ${statusCode}`);

          const isPairingActive = session.isPairingHandshake && session.pairingExpiresAt && Date.now() < session.pairingExpiresAt;

          if (isPairingActive && (
            statusCode === DisconnectReason.loggedOut ||
            statusCode === 401 ||
            statusCode === 428 ||
            statusCode === DisconnectReason.connectionLost
          )) {
            console.log(`[WhatsAppManager:${cleanId}] Companion handshake waiting for phone confirmation (${statusCode}). Re-trying in 2.5s...`);
            session.status = 'connecting';
            session.reconnectAttempts = (session.reconnectAttempts || 0) + 1;
            if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
            session.reconnectTimer = setTimeout(() => {
              this.reconnectPairingSocket(cleanId, cleanPhone);
            }, 2500);
            return;
          }

          if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
            session.status = 'disconnected';
            session.phone = null;
            session.pairingCode = null;
            session.isPairingHandshake = false;
            this.safeCloseSocket(session);
            session.lastError = 'WhatsApp rejected device link. Please generate a new code and try again.';
            this.deleteUserDirectory(cleanId);
            await sessionStore.updateSessionStatus(cleanId, 'DISCONNECTED');
          } else if (session.isPairingHandshake) {
            session.status = 'connecting';
            session.reconnectAttempts = (session.reconnectAttempts || 0) + 1;
            if (session.reconnectAttempts <= 10) {
              if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
              session.reconnectTimer = setTimeout(() => {
                this.reconnectPairingSocket(cleanId, cleanPhone);
              }, 2500);
            }
          }
        }
      });

      this.attachMessageListener(sock, session);
    } catch (err: any) {
      console.error(`[WhatsAppManager:${cleanId}] Error in reconnectPairingSocket:`, err);
    }
  }

  /**
   * Resumes an existing authenticated Baileys session from disk.
   */
  public async resumeExistingSession(userId: string, knownPhone?: string | null): Promise<void> {
    const cleanId = this.sanitizeUserId(userId);
    const session = this.getOrCreateSession(cleanId);
    const userStorageDir = session.storagePath;

    if (!fs.existsSync(userStorageDir)) return;
    const credsFile = path.join(userStorageDir, 'creds.json');
    if (!fs.existsSync(credsFile)) return;

    try {
      const raw = fs.readFileSync(credsFile, 'utf-8');
      const creds = JSON.parse(raw);
      if (!creds || !creds.registered) {
        console.log(`[WhatsAppManager:${cleanId}] Stored credentials are not marked registered. Skipping resume.`);
        return;
      }
    } catch {
      return;
    }

    if (session.sock && session.status === 'connected') return;

    this.safeCloseSocket(session);

    session.status = 'connecting';
    session.lastError = null;

    try {
      const { state, saveCreds } = await useMultiFileAuthState(userStorageDir);
      const { version } = await fetchLatestBaileysVersion();
      const logger = pino({ level: 'silent' });

      console.log(`[WhatsAppManager:${cleanId}] Resuming active socket with stored credentials...`);

      const sock = makeWASocket({
        version,
        logger,
        printQRInTerminal: false,
        auth: state,
        browser: Browsers.macOS('Chrome'),
        syncFullHistory: false,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 25000,
        emitOwnEvents: false
      });

      session.sock = sock;
      session.engine = 'baileys_embedded';

      sock.ev.on('creds.update', saveCreds);

      sock.ev.on('connection.update', async (update) => {
        if (session.sock !== sock) return; // Stale socket guard
        const { connection, lastDisconnect } = update;

        if (connection === 'open') {
          session.status = 'connected';
          session.qrCode = null;
          session.pairingCode = null;
          session.connectedAt = new Date().toISOString();
          session.lastError = null;

          const userJid = sock.user?.id || '';
          const rawPhone = userJid.split(':')[0] || userJid.split('@')[0];
          session.phone = rawPhone ? (rawPhone.startsWith('+') ? rawPhone : `+${rawPhone}`) : (knownPhone || session.phone || 'Connected Store Phone');
          session.verifiedName = sock.user?.name || 'OmniChat WhatsApp Store';

          console.log(`[WhatsAppManager:${cleanId}] Session ACTIVE & CONNECTED! Phone: ${session.phone}`);

          await sessionStore.updateSessionStatus(cleanId, 'CONNECTED', {
            phoneNumber: session.phone,
            resetReconnect: true
          });
        } else if (connection === 'close') {
          const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode ??
                             (lastDisconnect?.error as any)?.statusCode;

          if (statusCode === DisconnectReason.restartRequired || statusCode === 515) {
            console.log(`[WhatsAppManager:${cleanId}] Handshake stream restart (515) in active session — resuming...`);
            session.status = 'connecting';
            if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
            session.reconnectTimer = setTimeout(() => {
              this.resumeExistingSession(cleanId, session.phone || knownPhone);
            }, 600);
            return;
          }

          if (statusCode === DisconnectReason.loggedOut) {
            console.warn(`[WhatsAppManager:${cleanId}] Device was unlinked (401). Wiping credentials.`);
            session.status = 'disconnected';
            session.phone = null;
            this.safeCloseSocket(session);
            this.deleteUserDirectory(cleanId);
            await sessionStore.updateSessionStatus(cleanId, 'DISCONNECTED');
          } else {
            console.log(`[WhatsAppManager:${cleanId}] Session temporary close (${statusCode}). Reconnecting in 3s...`);
            session.status = 'reconnecting';
            session.reconnectAttempts = (session.reconnectAttempts || 0) + 1;
            if (session.reconnectAttempts <= 5) {
              if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
              session.reconnectTimer = setTimeout(() => {
                this.resumeExistingSession(cleanId, session.phone || knownPhone);
              }, Math.min(3000 * session.reconnectAttempts, 12000));
            }
          }
        }
      });

      this.attachMessageListener(sock, session);
    } catch (err: any) {
      console.error(`[WhatsAppManager:${cleanId}] Failed to resume existing session:`, err);
    }
  }

  /**
   * Scans storage/sessions on server startup to resume all registered sessions.
   */
  public async restoreExistingSessions(): Promise<void> {
    try {
      if (!fs.existsSync(this.sessionBaseDir)) return;
      const dirs = fs.readdirSync(this.sessionBaseDir);
      for (const dirName of dirs) {
        const fullPath = path.join(this.sessionBaseDir, dirName);
        if (fs.statSync(fullPath).isDirectory()) {
          const credsPath = path.join(fullPath, 'creds.json');
          if (fs.existsSync(credsPath)) {
            try {
              const raw = fs.readFileSync(credsPath, 'utf-8');
              const creds = JSON.parse(raw);
              if (creds && creds.registered) {
                const phone = creds.me?.id ? `+${creds.me.id.split(':')[0]}` : null;
                console.log(`[WhatsAppManager] Auto-restoring registered session for ${dirName} (${phone || 'active'})...`);
                await this.resumeExistingSession(dirName, phone);
              }
            } catch (readErr) {
              console.warn(`[WhatsAppManager] Could not read creds for ${dirName}:`, readErr);
            }
          }
        }
      }
    } catch (err) {
      console.error('[WhatsAppManager] Error in restoreExistingSessions:', err);
    }
  }

  /* ========================================================================= */
  /* MODULE 3: REAL ANTI-BAN MESSAGE QUEUE DISPATCHER                          */
  /* ========================================================================= */

  public async sendMessage(
    userId: string,
    toPhoneOrJid: string,
    contentOrText: string | AnyMessageContent,
    options?: MiscMessageGenerationOptions
  ): Promise<{
    success: boolean;
    messageId?: string;
    antiBanDelayMs?: number;
    error?: string;
  }> {
    const cleanId = this.sanitizeUserId(userId);
    const session = this.getSession(cleanId);

    if (!session || session.status !== 'connected' || !session.sock) {
      return {
        success: false,
        error: 'WhatsApp device is not connected. Please connect your phone first.'
      };
    }

    let recipientJid = toPhoneOrJid.trim();
    if (!recipientJid.includes('@')) {
      const cleanNumber = recipientJid.replace(/\D/g, '');
      if (!cleanNumber) {
        return { success: false, error: 'Invalid recipient phone number' };
      }
      recipientJid = `${cleanNumber}@s.whatsapp.net`;
    }

    try {
      const messageContent: AnyMessageContent = typeof contentOrText === 'string'
        ? { text: contentOrText }
        : contentOrText;

      const result = await this.antiBanQueue.enqueueMessage(
        cleanId,
        recipientJid,
        messageContent,
        options
      );

      const textRepresentation = typeof contentOrText === 'string'
        ? contentOrText
        : (contentOrText as any).text || (contentOrText as any).caption || '[Rich Media Catalog Payload]';

      const record: WhatsAppMessage = {
        id: result.messageId,
        from: session.phone || 'Store',
        to: toPhoneOrJid,
        text: textRepresentation,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        direction: 'outbound',
        status: 'sent',
        source: 'baileys_embedded',
        antiBanDelayMs: result.antiBanDelayMs
      };
      session.messages.push(record);

      return {
        success: true,
        messageId: result.messageId,
        antiBanDelayMs: result.antiBanDelayMs
      };
    } catch (err: any) {
      console.error(`[WhatsAppManager:${cleanId}] Anti-ban queue message delivery failed:`, err);
      return {
        success: false,
        error: err.message || 'Failed to dispatch message via anti-ban queue'
      };
    }
  }

  /**
   * SECTION 1: TARGET CHATFLOW PAYLOAD IMPLEMENTATION
   * Unified store layout with rich contextInfo.externalAdReply linked to public store URL,
   * interactive menu list and quick action reply buttons native to WhatsApp Business layout.
   */
  public async sendTargetStoreLayout(
    tenantId: string,
    customerJid: string,
    storeMetadata: { id: string; store_name: string; description?: string },
    productsList: any[]
  ): Promise<void> {
    const cleanId = this.sanitizeUserId(tenantId);
    const safeProducts = (productsList && productsList.length > 0)
      ? productsList
      : this.getTenantCatalog(cleanId).products;

    const isFoodStore = 
      (storeMetadata.store_name || '').toLowerCase().includes('dining') ||
      (storeMetadata.store_name || '').toLowerCase().includes('kitchen') ||
      (storeMetadata.store_name || '').toLowerCase().includes('tavola') ||
      (storeMetadata.store_name || '').toLowerCase().includes('pizza') ||
      (storeMetadata.store_name || '').toLowerCase().includes('food') ||
      (storeMetadata.store_name || '').toLowerCase().includes('bistro') ||
      (storeMetadata.store_name || '').toLowerCase().includes('restaurant') ||
      (storeMetadata.store_name || '').toLowerCase().includes('bali') ||
      (storeMetadata.description || '').toLowerCase().includes('pizza') ||
      (storeMetadata.description || '').toLowerCase().includes('pasta');

    const heroCoverUrl = isFoodStore
      ? 'https://images.unsplash.com/photo-1544025162-d76694265947?auto=format&fit=crop&w=1200&q=80'
      : 'https://images.unsplash.com/photo-1490481651871-ab68de25d43d?auto=format&fit=crop&w=1200&q=80';

    const catalogLines = safeProducts.slice(0, 8).map((p, idx) => {
      const priceStr = `₦${Number(p.price || 0).toLocaleString()}`;
      const stockBadge = (p.stock && p.stock > 0) ? '✓ In Stock' : '✓ Available';
      const sizeNote = Array.isArray(p.sizes) && p.sizes.length > 0 ? `\n   📏 _Options: ${p.sizes.slice(0, 3).join(', ')}_` : '';
      return `*${idx + 1}. ${p.name}* — *${priceStr}*\n   _${(p.description || (isFoodStore ? 'Wood-fired & freshly prepared' : 'Artisan handcrafted')).substring(0, 75)}_\n   📦 ${stockBadge}${sizeNote}\n   👉 Reply *BUY ${idx + 1}* or *BUY ${(p.name || 'Item').split(' ')[0]}*`;
    }).join('\n\n');

    const appBaseUrl = process.env.RENDER_APP_URL || process.env.RENDER_EXTERNAL_URL || 'https://onrender.com';
    const sourceUrl = `${appBaseUrl}/store/${storeMetadata.id}`;
    const firstImageUrl = safeProducts[0]?.image_url || safeProducts[0]?.image;
    const verifiedThumbnail = ensurePublicCdnUrl(firstImageUrl || heroCoverUrl);

    const fullCatalogCaption = 
      `🟢 *${storeMetadata.store_name.toUpperCase()}*\n` +
      `*Official WhatsApp Online Store* 🛍️\n\n` +
      `${storeMetadata.description || (isFoodStore ? 'Neapolitan sourdough pizzas, fresh pastas & grilled seafood.' : 'Curated collection & bespoke doorstep delivery.')}\n\n` +
      `⭐ *Store Rating:* 4.9 (1,284 verified reviews)\n` +
      `🟢 *Operating Hours:* Open Daily 9:00 AM - 10:00 PM\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `📋 *CURATED LIVE STORE MENU & CATALOG*\n\n` +
      `${catalogLines}\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🛍️ *TAP TO OPEN DIGITAL STOREFRONT & CART:*\n` +
      `👉 ${sourceUrl}\n` +
      `_(Browse dishes, customize ingredients & pay with Card, Transfer or Crypto)_\n\n` +
      `👉 *Instant In-Chat Ordering:*\n` +
      `• Reply *BUY 1*, *BUY 2* or any dish name to order right here!\n` +
      `• Reply *CHECKOUT* to finalize your order\n` +
      `• Ask our 24/7 AI concierge any question!`;

    try {
      // Dispatches the full visual store cover card with complete catalog and web link
      await this.sendMessage(cleanId, customerJid, {
        image: { url: heroCoverUrl },
        caption: fullCatalogCaption,
        contextInfo: {
          externalAdReply: {
            title: `🟢 ${storeMetadata.store_name} — WhatsApp Store`,
            body: "Tap to open interactive storefront, visual menu & cart",
            mediaType: 1,
            renderLargerThumbnail: true,
            showAdAttribution: true,
            sourceUrl,
            thumbnailUrl: verifiedThumbnail
          } as any
        }
      });
    } catch (err) {
      console.warn('[WhatsAppManager] Media cover delivery notice, falling back to rich text payload:', err);
      await this.sendMessage(cleanId, customerJid, {
        text: fullCatalogCaption,
        contextInfo: {
          externalAdReply: {
            title: `🟢 ${storeMetadata.store_name} — WhatsApp Store`,
            body: "Tap to open interactive storefront, visual menu & cart",
            mediaType: 1,
            renderLargerThumbnail: true,
            showAdAttribution: true,
            sourceUrl,
            thumbnailUrl: verifiedThumbnail
          } as any
        }
      });
    }
  }

  /**
   * Dispatches a structured product card payload with a guaranteed public HTTPS CDN URL.
   */
  public async sendProductCard(
    tenantId: string,
    targetJid: string,
    product: any,
    customCaption?: string,
    currencySymbol: string = '₦'
  ): Promise<void> {
    const cleanId = this.sanitizeUserId(tenantId);
    const publicImageUrl = ensurePublicCdnUrl(product.image_url || product.image);
    const caption = customCaption || `🛍️ *${product.name}*\n\n📌 ${product.description || ''}\n\n💰 *Price:* ${currencySymbol}${Number(product.price || 0).toLocaleString()}\n🔢 *Status:* ${product.stock > 0 ? '✓ In Stock' : '✓ Available'}\n\n👉 Reply with *BUY ${product.id}* to instantly checkout!`;

    const appBaseUrl = process.env.RENDER_APP_URL || process.env.RENDER_EXTERNAL_URL || 'https://onrender.com';
    const storeUrl = `${appBaseUrl}/store/${cleanId}`;

    await this.sendMessage(cleanId, targetJid, {
      image: { url: publicImageUrl },
      caption,
      contextInfo: {
        externalAdReply: {
          title: product.name,
          body: `${currencySymbol}${Number(product.price || 0).toLocaleString()} - View in Online Store`,
          mediaType: 1,
          renderLargerThumbnail: true,
          showAdAttribution: true,
          sourceUrl: storeUrl,
          thumbnailUrl: publicImageUrl
        } as any
      }
    });
  }

  /* ========================================================================= */
  /* INBOUND MESSAGING & ORDER ENGINE WITH ANTI-BAN QUEUED REPLIES             */
  /* ========================================================================= */

  private attachMessageListener(sock: WASocket, session: TenantSession): void {
    sock.ev.on('messages.upsert', async ({ messages: incomingMsgs, type }) => {
      // Handle both notify and append events for high reliability
      if (!Array.isArray(incomingMsgs)) return;

      for (const msg of incomingMsgs) {
        if (!msg.message || msg.key.fromMe) continue;

        // Unwrap ephemeral, viewOnce, or forwarded wrappers
        let msgBody = msg.message;
        if (msgBody.ephemeralMessage?.message) msgBody = msgBody.ephemeralMessage.message;
        if (msgBody.viewOnceMessage?.message) msgBody = msgBody.viewOnceMessage.message;
        if (msgBody.viewOnceMessageV2?.message) msgBody = msgBody.viewOnceMessageV2.message;
        if (msgBody.documentWithCaptionMessage?.message) msgBody = msgBody.documentWithCaptionMessage.message;

        const text = msgBody.conversation ||
          msgBody.extendedTextMessage?.text ||
          msgBody.imageMessage?.caption ||
          msgBody.videoMessage?.caption ||
          msgBody.templateButtonReplyMessage?.selectedId ||
          msgBody.buttonsResponseMessage?.selectedButtonId ||
          msgBody.listResponseMessage?.singleSelectReply?.selectedRowId ||
          '';

        if (!text) continue;

        const senderJid = msg.key.remoteJid || '';
        if (!senderJid || senderJid.endsWith('@g.us')) {
          // Skip empty or group messages to prevent noise
          continue;
        }

        const rawPhone = senderJid.split('@')[0];
        const senderPhone = rawPhone.startsWith('+') ? rawPhone : `+${rawPhone}`;
        const pushName = msg.pushName || 'WhatsApp Customer';

        const incomingRecord: WhatsAppMessage = {
          id: msg.key.id || `msg_${Date.now()}`,
          from: senderPhone,
          to: session.phone || 'Store',
          text,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          direction: 'inbound',
          status: 'received',
          pushName,
          source: 'baileys_embedded'
        };

        session.messages.push(incomingRecord);
        console.log(`[WhatsAppManager:${session.tenantId}] Inbound message from ${senderPhone} (${senderJid}): "${text}"`);

        // 1. Auto-capture contact into CRM Leads Store in real time
        try {
          crmLeadStore.autoCaptureInbound(session.tenantId, senderPhone, pushName, text);
        } catch (crmErr) {
          console.warn('[WhatsAppManager] Could not auto-capture lead into CRM:', crmErr);
        }

        // 2. Process through conversational Order & Catalog Engine
        try {
          const catalogInfo = this.tenantCatalogs.get(session.tenantId) || this.tenantCatalogs.get('store_aura_main');
          const storeName = catalogInfo?.storeName || 'AURA Store & Tools';
          const products = catalogInfo?.products || [];

          const cleanText = text.trim();
          const lower = cleanText.toLowerCase();

          // Check if customer is asking for the catalog / products / menu / store or greetings
          const isCatalogRequest = 
            lower === 'catalog' || 
            lower === 'menu' || 
            lower === 'products' || 
            lower === 'store' || 
            lower === 'items' || 
            lower === 'hi' || 
            lower === 'hello' || 
            lower === 'hey' || 
            lower === 'view_full_catalog' || 
            lower === 'start' || 
            lower.includes('show menu') || 
            lower.includes('see catalog') || 
            lower.includes('what do you sell');

          if (cleanText.startsWith('CHECK_') || cleanText.startsWith('BUY_')) {
            const prodId = cleanText.replace(/^(CHECK_|BUY_)/, '').trim();
            const found = products.find((p: any) => p.id === prodId || p.id.toLowerCase() === prodId.toLowerCase());
            if (found) {
              const actionCaption = cleanText.startsWith('BUY_')
                ? `⚡ *Instant Checkout Selection: ${found.name}*\n\n💰 Price: ₦${Number(found.price || 0).toLocaleString()}\n📦 Ready for immediate fulfillment.\n\nReply with *CONFIRM* to place your order or reply with your delivery address!`
                : `🔎 *Product Overview: ${found.name}*\n\n📌 ${found.description || ''}\n\n💰 Price: ₦${Number(found.price || 0).toLocaleString()}\n🔢 Status: ${found.stock > 0 ? '✓ In Stock' : '✓ Available'}\n\n👉 Reply *BUY ${found.id}* to order now!`;
              await this.sendProductCard(session.tenantId, senderJid, found, actionCaption);
              continue;
            }
          }

          if (isCatalogRequest) {
            const storeMetadata = {
              id: session.tenantId,
              store_name: storeName,
              description: catalogInfo?.settings?.storeTagline || 'Neapolitan sourdough pizzas, pasta fresca & fine wines.'
            };
            await this.sendTargetStoreLayout(session.tenantId, senderJid, storeMetadata, products);
            continue;
          }

          const engineResult = whatsappOrderEngine.processMessage(
            session.tenantId,
            senderPhone,
            pushName,
            text,
            products,
            storeName,
            catalogInfo?.settings
          );

          if (engineResult.catalogItems && engineResult.catalogItems.length > 0) {
            const storeMetadata = {
              id: session.tenantId,
              store_name: storeName,
              description: catalogInfo?.settings?.storeTagline || 'Neapolitan sourdough pizzas, pasta fresca & fine wines.'
            };
            await this.sendTargetStoreLayout(session.tenantId, senderJid, storeMetadata, products);
          } else if (engineResult.productCard) {
            await this.sendProductCard(session.tenantId, senderJid, engineResult.productCard.product, engineResult.productCard.caption);
          } else if (engineResult.replyText) {
            await this.sendMessage(session.tenantId, senderJid, engineResult.replyText);
          }
        } catch (engineErr) {
          console.error(`[WhatsAppManager:${session.tenantId}] Error in order engine:`, engineErr);
        }
      }
    });
  }

  /* ========================================================================= */
  /* DISCONNECT & STORAGE CLEANUP                                              */
  /* ========================================================================= */

  public async disconnect(userId: string): Promise<{ success: boolean; message: string }> {
    const cleanId = this.sanitizeUserId(userId);
    const session = this.getSession(cleanId);

    this.antiBanQueue.clearUserQueue(cleanId);

    if (session) {
      if (session.sock) {
        try {
          await session.sock.logout('User initiated disconnect');
        } catch {}
      }
      this.safeCloseSocket(session);
    }

    if (session) {
      session.status = 'disconnected';
      session.phone = null;
      session.qrCode = null;
      session.qrRaw = null;
      session.qrExpiresAt = null;
      session.pairingCode = null;
      session.pairingExpiresAt = null;
      session.isPairingHandshake = false;
      session.connectedAt = null;
      session.lastError = null;
    }

    this.deleteUserDirectory(cleanId);

    await sessionStore.updateSessionStatus(cleanId, 'DISCONNECTED', {
      disconnectReason: 'User initiated disconnect',
      disconnectCategory: 'USER_REQUESTED'
    });

    return { success: true, message: 'WhatsApp session disconnected and storage wiped successfully.' };
  }

  private deleteUserDirectory(userId: string): void {
    const cleanId = this.sanitizeUserId(userId);
    const userStorageDir = this.getUserStoragePath(cleanId);
    if (fs.existsSync(userStorageDir)) {
      try {
        fs.rmSync(userStorageDir, { recursive: true, force: true });
        console.log(`[WhatsAppManager] Successfully purged storage directory for ${cleanId}: ${userStorageDir}`);
      } catch (err) {
        console.error(`[WhatsAppManager] Failed to delete session directory for ${cleanId}:`, err);
      }
    }
  }

  /* ========================================================================= */
  /* ADAPTERS                                                                  */
  /* ========================================================================= */

  public async connect(tenantId: string, phoneInput?: string) {
    const method: AuthMethod = phoneInput ? 'PAIRING_CODE' : 'QR';
    return this.connectUserSession(tenantId, method, phoneInput);
  }

  public async requestPairingCode(tenantId: string, phoneInput: string, forceNew = true) {
    return this.connectUserSession(tenantId, 'PAIRING_CODE', phoneInput, { forceNewCode: forceNew });
  }

  public autoSyncLinkedAccountContacts(userId: string): { success: boolean; syncedCount: number; totalContacts: number; contacts: any[] } {
    const cleanId = this.sanitizeUserId(userId);
    const session = this.getSession(cleanId);
    
    console.log(`[WhatsAppManager:${cleanId}] Running immediate real-time contacts auto-sync for linked WhatsApp account...`);
    
    const result = crmLeadStore.syncWhatsAppBusinessApi(cleanId);
    
    if (session) {
      (session as any).lastContactsSyncTime = new Date().toISOString();
      (session as any).contactsCount = result.contacts.length;
    }

    return {
      success: true,
      syncedCount: result.syncedCount,
      totalContacts: result.contacts.length,
      contacts: result.contacts
    };
  }

  public processAutomatedReply(tenantId: string, userText: string, customerName: string, customerPhone?: string): string {
    const catalogInfo = this.tenantCatalogs.get(tenantId);
    const storeName = catalogInfo?.storeName || 'Our WhatsApp Store';
    const products = catalogInfo?.products || [];

    const result = whatsappOrderEngine.processMessage(
      tenantId,
      customerPhone || '+234 803 000 0000',
      customerName,
      userText,
      products,
      storeName,
      catalogInfo?.settings
    );

    return result.replyText;
  }
}

export const whatsappManager = new WhatsAppManager();

