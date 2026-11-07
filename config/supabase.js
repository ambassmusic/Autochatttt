// config/supabase.js
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabaseUrl = 
  process.env.SUPABASE_URL || 
  process.env.VITE_SUPABASE_URL || 
  'https://tdafafmuflygakcdhfyq.supabase.co';

const supabaseServiceKey = 
  process.env.SUPABASE_SERVICE_ROLE_KEY || 
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_SERVICE_KEY || 
  process.env.VITE_SUPABASE_ANON_KEY || 
  process.env.SUPABASE_PUBLISHABLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  '';

// Strict Production Boot Gate Guard: Prevents Build Crash (Exit Code 1)
if (!supabaseUrl || !supabaseServiceKey) {
  console.warn("⚠️ WARNING: Supabase Environment credentials are not fully loaded in this build environment frame yet.");
}

// Instantiate fallback safely so compilation does not throw absolute exceptions
export const supabase = (supabaseUrl && supabaseServiceKey) 
  ? createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    })
  : null;

export default supabase;
