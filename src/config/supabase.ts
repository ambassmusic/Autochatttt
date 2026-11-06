// src/config/supabase.ts
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

if (typeof process !== 'undefined' && process.env) {
  dotenv.config();
}

const supabaseUrl = 
  (typeof process !== 'undefined' && (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL)) ||
  (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_SUPABASE_URL);

const supabaseServiceKey = 
  (typeof process !== 'undefined' && (
    process.env.SUPABASE_SERVICE_ROLE_KEY || 
    process.env.SUPABASE_SERVICE_KEY || 
    process.env.VITE_SUPABASE_ANON_KEY || 
    process.env.SUPABASE_ANON_KEY
  )) ||
  (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_SUPABASE_ANON_KEY);

// Strict Production Boot Gate Guard: Prevents Build Crash (Exit Code 1)
if (!supabaseUrl || !supabaseServiceKey) {
  console.warn("⚠️ WARNING: Supabase Environment credentials are not fully loaded in this build environment frame yet.");
}

// Instantiate fallback safely so compilation does not throw absolute exceptions
export const supabase: SupabaseClient | null = (supabaseUrl && supabaseServiceKey) 
  ? createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    })
  : null;

export default supabase;
