// 中 / English / Français. The Chinese text is the key: t('经营总览') → 'Tableau de bord' in French.
// A string with no translation yet falls back to Chinese, so the app never shows a blank.
// Coverage today: navigation, top bar, statuses, workflow steps, customer documents, common buttons.
let LANG = (() => { try { return JSON.parse(localStorage.getItem('la9s.lang')) || 'zh'; } catch { return 'zh'; } })();
export const getLang = () => LANG;
export function setLang(l) { LANG = l; try { localStorage.setItem('la9s.lang', JSON.stringify(l)); } catch { /* ignore */ } }
export const LANGS = [['zh', '中文'], ['en', 'English'], ['fr', 'Français']];

const D = {
  // navigation
  '工作台': ['Workspace', 'Espace de travail'], '经营总览': ['Dashboard', 'Tableau de bord'], '我的待办': ['My tasks', 'Mes tâches'],
  '销售主链': ['Sales', 'Ventes'], '新建询单 / 报价': ['New quote', 'Nouveau devis'], '订单总览': ['Orders', 'Commandes'],
  '客户': ['Customers', 'Clients'], '客户档案': ['Customer files', 'Fiches clients'], '热线回访': ['Hotline follow-up', 'Suivi hotline'], '销售拜访': ['Sales visits', 'Visites commerciales'],
  '财务': ['Finance', 'Finance'], '收款与冲账': ['Receipts', 'Encaissements'], '客户总账 Balance': ['Customer balance', 'Balance clients'], '资金账户': ['Cash accounts', 'Comptes de trésorerie'],
  '仓库': ['Warehouse', 'Entrepôt'], '库存（实存/预占/可售）': ['Stock', 'Stock'], '未满足需求': ['Unmet demand', 'Demande non servie'], '备货看板': ['Replenishment', 'Réassort'],
  '物料名称管理（中方）': ['Item names (admin)', 'Noms des articles (admin)'], '物料与定价': ['Items & pricing', 'Articles et prix'], '数据导入': ['Data import', 'Import de données'],
  '后续版本': ['Coming later', 'Plus tard'], '设置': ['Settings', 'Paramètres'], '岗位': ['Role', 'Poste'], '语言': ['Language', 'Langue'],
  // roles
  '中方': ['Management (CN)', 'Direction (CN)'], '仓库主管': ['Warehouse supervisor', 'Chef d’entrepôt'], '热线': ['Hotline', 'Hotline'],
  '销售': ['Sales rep', 'Commercial'], '仓库管理员': ['Warehouse clerk', 'Magasinier'], '找货员': ['Warehouse clerk', 'Magasinier'],
  // statuses
  '已报价': ['Quoted', 'Devis envoyé'], '热线已确认': ['Hotline confirmed', 'Confirmé par hotline'], '找货中 · 已预占': ['Picking · reserved', 'Préparation · réservé'],
  '已初拣 · 待出销售订单': ['Picked · awaiting sales order', 'Préparé · bon de commande à faire'], '待客户确认': ['Awaiting customer', 'En attente du client'],
  '待复检打包': ['To check & pack', 'À contrôler et emballer'], '已打包 · 待出库': ['Packed · to ship', 'Emballé · à expédier'],
  '部分出库': ['Partly shipped', 'Expédié en partie'], '已出库': ['Shipped', 'Expédié'], '已作废': ['Voided', 'Annulé'], '已取消': ['Voided', 'Annulé'],
  // steps
  '报价': ['Quote', 'Devis'], '热线确认': ['Hotline', 'Hotline'], '找货单': ['Pick list', 'Bon de préparation'], '初拣': ['Picking', 'Préparation'],
  '销售订单': ['Sales order', 'Bon de commande'], '客户确认': ['Customer OK', 'Accord client'], '复检打包': ['Check & pack', 'Contrôle et emballage'],
  '出库': ['Shipping', 'Expédition'], '收款': ['Payment', 'Paiement'], '退货': ['Returns', 'Retours'],
  // documents (customer facing)
  '报价单': ['Quotation', 'Devis'], '对账单': ['Statement', 'Relevé de compte'], '退货对账单': ['Return statement', 'Relevé de retour'],
  '编码': ['Code', 'Code'], '种类': ['Type', 'Type'], '型号': ['Model', 'Modèle'], '通用性': ['Compatible', 'Compatible'],
  '数量': ['Qty', 'Qté'], '供货数量': ['Qty supplied', 'Qté livrée'], '单价': ['Unit price', 'Prix unitaire'], '金额': ['Amount', 'Montant'], '合计': ['Total', 'Total'],
  '个型号': ['models', 'modèles'], '件': ['pcs', 'pcs'], '本单': ['This order', 'Cette commande'], '应收': ['Due', 'À payer'], '实收': ['Paid', 'Payé'],
  '待付': ['Balance', 'Reste à payer'], '已付清': ['Paid in full', 'Soldé'], '总账': ['Account', 'Compte'], '总账（含本单）': ['Account (incl. this order)', 'Compte (cette commande incluse)'],
  '累计购买': ['Total bought', 'Total acheté'], '累计已付': ['Total paid', 'Total payé'], '累计退货': ['Total returned', 'Total retourné'],
  '当前欠款': ['Amount owed', 'Montant dû'], '已结清': ['Settled', 'Soldé'], '当前客户无欠款，此为预付': ['No debt — prepaid', 'Aucune dette — avance'],
  '未结清订单': ['Unpaid orders', 'Commandes non soldées'], '其余': ['Other', 'Autres'], '单合计': ['orders total', 'commandes au total'],
  '生成时间': ['Generated', 'Généré le'], '金额单位': ['Currency', 'Devise'],
  // common buttons
  '复制图片': ['Copy image', 'Copier l’image'], '复制文字': ['Copy text', 'Copier le texte'], '打印': ['Print', 'Imprimer'],
  '保存': ['Save', 'Enregistrer'], '取消': ['Cancel', 'Annuler'], '确认': ['Confirm', 'Confirmer'], '搜索': ['Search', 'Rechercher'],
};
export function t(zh) {
  if (LANG === 'zh' || zh == null) return zh;
  const e = D[zh];
  return e ? e[LANG === 'en' ? 0 : 1] : zh;
}
// share of a Chinese string list that has a translation (shown in settings so nobody mistakes partial for done)
export const coverage = () => Object.keys(D).length;
