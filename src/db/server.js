// 服务器版 (VITE_SERVER=1): 数据在 Supabase 上, 前端用登录账号的身份读写.
// 通道: public.exec_sql (只读 SELECT / 调 app.* 业务函数, 受 RLS 和函数里的权限检查管) —— 线上演示环境用; 上线前换成具体接口.
import { createClient } from '@supabase/supabase-js';
import { inlineSql } from '../lib/sqlinline.js';

const URL = import.meta.env.VITE_SB_URL, KEY = import.meta.env.VITE_SB_KEY;
// 懒创建: 浏览器演示版 / 真实数据版没有服务器地址, 引入这个文件不能报错
let _sb = null;
const sbc = () => (_sb ||= createClient(URL, KEY, { auth: { persistSession: true, autoRefreshToken: true } }));

export const loginEmail = (id) => {
  const s = String(id || '').trim().toLowerCase();
  return s.includes('@') ? s : `${s.replace(/_/g, '-')}@demo.la9s.com`;
};
export async function login(id, password) {
  const { error } = await sbc().auth.signInWithPassword({ email: loginEmail(id), password });
  if (error) throw new Error(/invalid/i.test(error.message) ? '工号或密码不对' : error.message);
}
export async function logout() { await sbc().auth.signOut(); }

const clean = (s) => s.trim().replace(/;+\s*$/, '');
export async function exec(sql, params = []) {
  const { data, error } = await sbc().rpc('exec_sql', { q: clean(inlineSql(sql, params)) });
  if (error) {
    const e = new Error(error.message || String(error));
    if (/JWT|NOT_AUTHENTICATED/.test(e.message)) e.needLogin = true;
    throw e;
  }
  return data || [];
}

export async function openServer() {
  const { data } = await sbc().auth.getSession();
  if (!data?.session) { const e = new Error('请先登录'); e.needLogin = true; throw e; }
  const rows = await exec('select org_id, roles from app.members where user_id = auth.uid()');
  if (!rows.length) { const e = new Error('这个账号还没有加入公司，请联系中方'); e.noMember = true; throw e; }
  const me = data.session.user;
  return { org: rows[0].org_id, roles: [...new Set(rows.flatMap((r) => r.roles || []))], email: me.email, persistent: true };
}
