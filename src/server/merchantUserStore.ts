import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { AuthUser, BusinessIndustry } from '../types/index.js';

export interface StoredMerchantUser {
  id: string;
  email: string;
  name: string;
  businessName: string;
  industry: BusinessIndustry;
  country?: string;
  role: 'merchant' | 'superadmin';
  planTier: 'starter' | 'pro' | 'enterprise';
  passwordHash: string;
  salt: string;
  createdAt: string;
  updatedAt: string;
}

export const SUPERADMIN_EMAILS = [
  'musicben92@gmail.com',
  'weightlosstipsinside@gmail.com',
  'didyndiadan@gmail.com'
];

export function isSuperAdminEmail(email?: string | null): boolean {
  if (!email) return false;
  return SUPERADMIN_EMAILS.includes(email.trim().toLowerCase());
}

class MerchantUserStore {
  private users = new Map<string, StoredMerchantUser>(); // Key: lowercase email
  private readonly dbDir = path.resolve(process.cwd(), 'storage', 'database');
  private readonly dbFilePath = path.join(this.dbDir, 'merchants.json');
  private isLoaded = false;

  constructor() {
    this.ensureStorage();
    this.loadFromDisk();
  }

  private ensureStorage(): void {
    if (!fs.existsSync(this.dbDir)) {
      try {
        fs.mkdirSync(this.dbDir, { recursive: true });
      } catch (err) {
        console.error('[MerchantUserStore] Failed to create database directory:', err);
      }
    }
  }

  private hashPassword(password: string, salt: string): string {
    return crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
  }

  private generateSalt(): string {
    return crypto.randomBytes(16).toString('hex');
  }

  private loadFromDisk(): void {
    try {
      if (fs.existsSync(this.dbFilePath)) {
        const raw = fs.readFileSync(this.dbFilePath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          this.users.clear();
          for (const item of parsed) {
            if (item && item.email) {
              this.users.set(item.email.toLowerCase(), item);
            }
          }
        }
      }
    } catch (err) {
      console.warn('[MerchantUserStore] Error loading from disk:', err);
    }
    this.isLoaded = true;
  }

  private saveToDisk(): void {
    try {
      this.ensureStorage();
      const list = Array.from(this.users.values());
      fs.writeFileSync(this.dbFilePath, JSON.stringify(list, null, 2), 'utf-8');
    } catch (err) {
      console.error('[MerchantUserStore] Error saving users to disk:', err);
    }
  }

  public register(params: {
    email: string;
    password: string;
    name: string;
    businessName?: string;
    industry?: BusinessIndustry;
    country?: string;
  }): { success: boolean; user?: AuthUser; token?: string; error?: string } {
    const emailNorm = params.email.trim().toLowerCase();
    if (!emailNorm || !emailNorm.includes('@')) {
      return { success: false, error: 'A valid email address is required.' };
    }
    if (!params.password || params.password.length < 6) {
      return { success: false, error: 'Password must be at least 6 characters.' };
    }

    if (this.users.has(emailNorm)) {
      return { success: false, error: 'An account with this email already exists. Please log in.' };
    }

    const salt = this.generateSalt();
    const passwordHash = this.hashPassword(params.password, salt);
    const userId = `usr_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const role: 'merchant' | 'superadmin' = isSuperAdminEmail(emailNorm) ? 'superadmin' : 'merchant';
    const cleanName = params.name.trim() || emailNorm.split('@')[0];
    const cleanBusiness = params.businessName?.trim() || `${cleanName}'s Store`;
    const cleanIndustry = params.industry || 'fashion';

    const record: StoredMerchantUser = {
      id: userId,
      email: emailNorm,
      name: cleanName,
      businessName: cleanBusiness,
      industry: cleanIndustry,
      country: params.country || 'United States',
      role,
      planTier: 'starter',
      passwordHash,
      salt,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    this.users.set(emailNorm, record);
    this.saveToDisk();

    const authUser: AuthUser = {
      id: record.id,
      name: record.name,
      email: record.email,
      role: record.role,
      businessName: record.businessName,
      industry: record.industry,
      planTier: record.planTier
    };

    const token = Buffer.from(JSON.stringify({ uid: record.id, email: record.email, time: Date.now() })).toString('base64');

    return { success: true, user: authUser, token };
  }

  public login(email: string, password: string): { success: boolean; user?: AuthUser; token?: string; error?: string } {
    const emailNorm = email.trim().toLowerCase();
    const record = this.users.get(emailNorm);
    if (!record) {
      return { success: false, error: 'Account not found. Please register to create your store account.' };
    }

    const checkHash = this.hashPassword(password, record.salt);
    if (checkHash !== record.passwordHash) {
      return { success: false, error: 'Invalid password. Please check your credentials.' };
    }

    // Update role if user is superadmin
    if (isSuperAdminEmail(emailNorm) && record.role !== 'superadmin') {
      record.role = 'superadmin';
      record.updatedAt = new Date().toISOString();
      this.saveToDisk();
    }

    const authUser: AuthUser = {
      id: record.id,
      name: record.name,
      email: record.email,
      role: record.role,
      businessName: record.businessName,
      industry: record.industry,
      planTier: record.planTier
    };

    const token = Buffer.from(JSON.stringify({ uid: record.id, email: record.email, time: Date.now() })).toString('base64');

    return { success: true, user: authUser, token };
  }

  public findByEmail(email: string): AuthUser | null {
    const record = this.users.get(email.trim().toLowerCase());
    if (!record) return null;
    return {
      id: record.id,
      name: record.name,
      email: record.email,
      role: record.role,
      businessName: record.businessName,
      industry: record.industry,
      planTier: record.planTier
    };
  }

  public getAll(): StoredMerchantUser[] {
    return Array.from(this.users.values());
  }
}

export const merchantUserStore = new MerchantUserStore();
