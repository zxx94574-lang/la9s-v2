-- 服务器冒烟测试: 走一遍主链 (报价 → 找货 → 销售单 → 客户确认 → 复检 → 出库), 再查权限隔离; 最后抛异常整笔回滚, 不留任何数据.
do $$
declare
  u_admin uuid := gen_random_uuid(); u_mgr uuid := gen_random_uuid(); u_pick uuid := gen_random_uuid();
  u_hot uuid := gen_random_uuid(); u_out uuid := gen_random_uuid();
  o uuid; o2 uuid; e_pick uuid; e_rev uuid; cat uuid; p uuid; w uuid; c uuid; d uuid; st text; onhand numeric; seen int; seen2 int; bal numeric;
begin
  insert into app.currencies values ('XOF',0) on conflict do nothing;
  insert into app.countries values ('CI','科特迪瓦','Côte d''Ivoire','XOF') on conflict do nothing;
  insert into app.orgs (kind,name,country,base_currency,doc_prefix) values ('hq','SMOKE','CI','XOF','SM') returning id into o;
  insert into app.orgs (kind,name,country,base_currency,doc_prefix) values ('hq','SMOKE2','CI','XOF','SN') returning id into o2;
  insert into app.employees (org_id, short_name) values (o,'PICK') returning id into e_pick;
  insert into app.employees (org_id, short_name) values (o,'REV') returning id into e_rev;
  insert into app.members (user_id, org_id, roles) values (u_admin,o,'{admin}'),(u_mgr,o,'{manager}'),(u_pick,o,'{picker}'),(u_hot,o,'{hotline}'),(u_out,o2,'{admin}');
  insert into app.org_settings (org_id, key, value) values (o, 'rep_debt_rules', '{"on":false}') on conflict do nothing;
  insert into app.categories (org_id,name) values (o,'屏幕') returning id into cat;
  insert into app.products (org_id,code,category_id,model) values (o,'9001',cat,'SMK1') returning id into p;
  insert into app.product_prices values (p,'WHOLESALE','XOF',3300);
  insert into app.warehouses (org_id,code,name,kind) values (o,'LA','LA','local') returning id into w;
  insert into app.stock_items (warehouse_id,product_id,qty_on_hand,bin) values (w,p,60,'A-1');
  insert into app.customers (org_id,code,name,city,status,tier) values (o,'S001','SMOKE CUST','Abobo','active','WHOLESALE') returning id into c;

  perform set_config('request.jwt.claim.sub', u_mgr::text, true);
  d := app.create_quote(o, c, 'XOF', jsonb_build_array(jsonb_build_object('product_id', p, 'qty_req', 10)));
  perform app.start_picking(d);
  perform set_config('request.jwt.claim.sub', u_pick::text, true);
  perform app.submit_pick(d, e_pick, 'photo://pick.jpg', '[]');
  perform set_config('request.jwt.claim.sub', u_mgr::text, true);
  perform app.create_sales_order(d, false);
  perform set_config('request.jwt.claim.sub', u_hot::text, true);
  perform app.customer_confirm(d, null, 'whatsapp', 'proof://ok.jpg');
  perform set_config('request.jwt.claim.sub', u_mgr::text, true);
  perform app.review_pick(d, e_rev, 'photo://pack.jpg');
  perform app.ship(d, now(), 'yango_moto', '+2250700000000', 'Abobo', 'proof://yango.jpg', null);
  select status into st from app.deals where id = d;
  select qty_on_hand into onhand from app.stock_items where product_id = p;
  select coalesce(sum(amount),0) into bal from app.ar_entries where customer_id = c;

  -- 权限: 以登录用户身份读, 本公司看得到, 别的公司看不到
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', u_mgr::text, true);
  select count(*) into seen from app.deals where id = d;
  perform set_config('request.jwt.claim.sub', u_out::text, true);
  select count(*) into seen2 from app.deals where id = d;
  reset role;
  raise exception 'SMOKE_RESULT status=% stock=% ledger=% own_org_sees=% other_org_sees=%', st, onhand, bal, seen, seen2;
end $$;
