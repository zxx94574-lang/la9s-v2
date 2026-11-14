-- 2026-11-14 上服务器时发现: 这几张表有 RLS 策略, 但漏了给登录用户的读权限 (浏览器演示版用超级用户读, 一直没暴露).
-- 只补 SELECT, 行级可见范围仍由各表原来的策略决定.
grant select on app.bad_debt_writeoffs, app.cash_checks, app.employee_files, app.issue_reports,
  app.payroll_months, app.period_locks, app.row_attrs to authenticated;
