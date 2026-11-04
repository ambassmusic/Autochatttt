export interface WhatsAppStatusResponse {
  tenantId: string;
  instanceName?: string;
  status: 'disconnected' | 'connecting' | 'qrcode' | 'connected' | 'reconnecting' | 'error';
  authMethod?: 'QR' | 'PAIRING_CODE';
  phone: string | null;
  qrCode: string | null;
  pairingCode?: string | null;
  expiresInSeconds: number;
  pairingExpiresInSeconds?: number;
  verifiedName: string | null;
  connectedAt?: string | null;
  lastPingMs?: number;
  error: string | null;
  engine: 'baileys_embedded' | 'evolution_api';
  messageCount?: number;
  antiBanQueue?: {
    pendingCount: number;
    isProcessing: boolean;
    totalSent: number;
    totalFailed: number;
    lastSentAt: string | null;
    lastDelayMs: number;
  };
  dbSession?: any;
}

export interface WhatsAppMessageItem {
  id: string;
  from: string;
  to: string;
  text: string;
  timestamp: string;
  direction: 'inbound' | 'outbound';
  status: 'sent' | 'delivered' | 'read' | 'failed' | 'received';
  pushName?: string;
  source: 'baileys_embedded' | 'evolution_api';
}

export interface WhatsAppConfigResponse {
  evolutionConfig: {
    apiUrl: string;
    apiKey: string;
    enabled: boolean;
    hasValidConfig: boolean;
  };
  activeEngine: 'evolution_remote' | 'baileys_embedded';
  activeSessionsCount: number;
  activeSessions: Array<{
    tenantId: string;
    status: string;
    phone: string | null;
    engine: string;
    connectedAt: string | null;
  }>;
}

class WhatsAppClient {
  private getHeaders(tenantId: string) {
    return {
      'Content-Type': 'application/json',
      'x-tenant-id': tenantId
    };
  }

  public async getConfig(): Promise<WhatsAppConfigResponse> {
    const res = await fetch('/api/whatsapp/config');
    if (!res.ok) throw new Error('Failed to fetch WhatsApp configuration');
    return res.json();
  }

  public async updateConfig(apiUrl: string, apiKey: string, enabled: boolean): Promise<any> {
    const res = await fetch('/api/whatsapp/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiUrl, apiKey, enabled })
    });
    if (!res.ok) throw new Error('Failed to update WhatsApp configuration');
    return res.json();
  }

  public async connect(tenantId: string, phone?: string): Promise<WhatsAppStatusResponse> {
    const res = await fetch('/api/whatsapp/connect', {
      method: 'POST',
      headers: this.getHeaders(tenantId),
      body: JSON.stringify({ phone })
    });
    const data = await res.json();
    if (!res.ok && !data.qrCode) {
      throw new Error(data.error || 'Failed to initiate WhatsApp connection');
    }
    return data;
  }

  public async requestPairingCode(tenantId: string, phone: string): Promise<{
    success: boolean;
    pairingCode?: string;
    phone?: string;
    pairingExpiresInSeconds?: number;
    expiresInSeconds?: number;
    error?: string;
  }> {
    const res = await fetch('/api/whatsapp/pairing-code', {
      method: 'POST',
      headers: this.getHeaders(tenantId),
      body: JSON.stringify({ phone })
    });
    const data = await res.json();
    if (!res.ok && !data.pairingCode) {
      throw new Error(data.error || 'Failed to request WhatsApp pairing code');
    }
    return data;
  }

  public async getStatus(tenantId: string): Promise<WhatsAppStatusResponse> {
    const res = await fetch(`/api/whatsapp/status?tenantId=${encodeURIComponent(tenantId)}`, {
      headers: this.getHeaders(tenantId)
    });
    if (!res.ok) throw new Error('Failed to fetch WhatsApp status');
    return res.json();
  }

  public async disconnect(tenantId: string): Promise<{ success: boolean; message: string }> {
    const res = await fetch('/api/whatsapp/disconnect', {
      method: 'POST',
      headers: this.getHeaders(tenantId)
    });
    if (!res.ok) throw new Error('Failed to disconnect WhatsApp');
    return res.json();
  }

  public async sendMessage(tenantId: string, phone: string, text: string): Promise<{ success: boolean; messageId?: string; error?: string }> {
    const res = await fetch('/api/whatsapp/send', {
      method: 'POST',
      headers: this.getHeaders(tenantId),
      body: JSON.stringify({ phone, text })
    });
    return res.json();
  }

  public async getMessages(tenantId: string): Promise<{ tenantId: string; messages: WhatsAppMessageItem[] }> {
    const res = await fetch(`/api/whatsapp/messages?tenantId=${encodeURIComponent(tenantId)}`, {
      headers: this.getHeaders(tenantId)
    });
    if (!res.ok) throw new Error('Failed to fetch WhatsApp messages');
    return res.json();
  }

  public async connectUserSession(userId: string, authMethod: 'QR' | 'PAIRING_CODE', phoneNumber?: string): Promise<any> {
    const res = await fetch('/api/whatsapp/user-session/connect', {
      method: 'POST',
      headers: this.getHeaders(userId),
      body: JSON.stringify({ userId, authMethod, phoneNumber })
    });
    return res.json();
  }

  public async getSessions(): Promise<{ success: boolean; count: number; sessions: any[] }> {
    const res = await fetch('/api/whatsapp/sessions');
    if (!res.ok) throw new Error('Failed to fetch tracked database sessions');
    return res.json();
  }

  public async getQueueMetrics(tenantId: string): Promise<any> {
    const res = await fetch(`/api/whatsapp/queue/metrics?tenantId=${encodeURIComponent(tenantId)}`, {
      headers: this.getHeaders(tenantId)
    });
    return res.json();
  }

  public async testSimulation(tenantId: string, from?: string, text?: string): Promise<any> {
    const res = await fetch('/api/whatsapp/test-simulation', {
      method: 'POST',
      headers: this.getHeaders(tenantId),
      body: JSON.stringify({ from, text })
    });
    return res.json();
  }

  /* CRM Leads Management */
  public async getLeads(tenantId: string): Promise<{ success: boolean; count: number; leads: any[] }> {
    const res = await fetch(`/api/crm/leads?tenantId=${encodeURIComponent(tenantId)}`, {
      headers: this.getHeaders(tenantId)
    });
    if (!res.ok) throw new Error('Failed to fetch CRM leads');
    return res.json();
  }

  public async addLead(tenantId: string, lead: any): Promise<{ success: boolean; lead: any }> {
    const res = await fetch('/api/crm/leads', {
      method: 'POST',
      headers: this.getHeaders(tenantId),
      body: JSON.stringify(lead)
    });
    if (!res.ok) throw new Error('Failed to save CRM lead');
    return res.json();
  }

  public async importLeads(tenantId: string, contacts: any[]): Promise<any> {
    const res = await fetch('/api/crm/leads/import', {
      method: 'POST',
      headers: this.getHeaders(tenantId),
      body: JSON.stringify({ contacts })
    });
    if (!res.ok) throw new Error('Failed to bulk import CRM leads');
    return res.json();
  }

  public async broadcastToLeads(tenantId: string, messageText: string, phoneNumbers: string[]): Promise<any> {
    const res = await fetch('/api/crm/broadcast', {
      method: 'POST',
      headers: this.getHeaders(tenantId),
      body: JSON.stringify({ messageText, phoneNumbers })
    });
    return res.json();
  }

  /* WhatsApp Contacts Module (Tenant Scoped) */
  public async getContacts(tenantId: string): Promise<{ success: boolean; totalContacts: number; contacts: any[] }> {
    const res = await fetch(`/api/whatsapp/contacts?tenantId=${encodeURIComponent(tenantId)}`, {
      headers: this.getHeaders(tenantId)
    });
    if (!res.ok) throw new Error('Failed to fetch WhatsApp contacts');
    return res.json();
  }

  public async syncContacts(tenantId: string, industry?: string): Promise<{ success: boolean; syncedCount: number; source: string; contacts: any[] }> {
    const res = await fetch('/api/whatsapp/contacts/sync', {
      method: 'POST',
      headers: this.getHeaders(tenantId),
      body: JSON.stringify({ industry })
    });
    if (!res.ok) throw new Error('Failed to sync WhatsApp contacts');
    return res.json();
  }

  public async addContact(tenantId: string, contact: any): Promise<{ success: boolean; contact: any }> {
    const res = await fetch('/api/whatsapp/contacts', {
      method: 'POST',
      headers: this.getHeaders(tenantId),
      body: JSON.stringify(contact)
    });
    if (!res.ok) throw new Error('Failed to add WhatsApp contact');
    return res.json();
  }

  public async deleteContact(tenantId: string, phone: string): Promise<{ success: boolean; deleted: boolean }> {
    const res = await fetch(`/api/whatsapp/contacts/${encodeURIComponent(phone)}`, {
      method: 'DELETE',
      headers: this.getHeaders(tenantId)
    });
    if (!res.ok) throw new Error('Failed to delete WhatsApp contact');
    return res.json();
  }

  /* Real-time AI Latency Monitor */
  public async getAiLatency(tenantId: string): Promise<any> {
    const res = await fetch(`/api/whatsapp/ai-latency?tenantId=${encodeURIComponent(tenantId)}`, {
      headers: this.getHeaders(tenantId)
    });
    if (!res.ok) throw new Error('Failed to fetch AI latency metrics');
    return res.json();
  }

  public async recordAiLatency(tenantId: string, latencyMs: number, prompt: string, response: string, source = 'simulator'): Promise<any> {
    const res = await fetch('/api/whatsapp/ai-latency/record', {
      method: 'POST',
      headers: this.getHeaders(tenantId),
      body: JSON.stringify({ latencyMs, prompt, response, source })
    });
    return res.json();
  }

  public async runAiBenchmark(tenantId: string, prompt?: string): Promise<any> {
    const res = await fetch('/api/whatsapp/ai-latency/benchmark', {
      method: 'POST',
      headers: this.getHeaders(tenantId),
      body: JSON.stringify({ prompt })
    });
    if (!res.ok) throw new Error('Failed to run AI benchmark');
    return res.json();
  }
}

export const whatsAppClient = new WhatsAppClient();

