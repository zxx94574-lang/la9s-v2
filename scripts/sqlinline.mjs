// 把 $1、$2… 参数换成 SQL 字面量 (一律写成带引号的「未定类型」字面量, 和 PGlite 传参时 Postgres 推断类型的方式一样).
// 服务器版前端 (exec_sql) 和服务器灌数脚本共用.
const lit = (v) => {
  if (v === null || v === undefined) return 'NULL';
  if (v instanceof Date) v = v.toISOString();
  if (Array.isArray(v)) {
    const el = (x) => (x === null || x === undefined ? 'NULL' : '"' + String(typeof x === 'object' ? JSON.stringify(x) : x).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"');
    v = '{' + v.map(el).join(',') + '}';
  } else if (typeof v === 'object') v = JSON.stringify(v);
  return "'" + String(v).replace(/'/g, "''") + "'";
};
export function inlineSql(sql, params = []) {
  if (!params || !params.length) return sql;
  return sql.replace(/\$(\d+)\b/g, (m, n) => (Number(n) <= params.length ? lit(params[Number(n) - 1]) : m));
}
