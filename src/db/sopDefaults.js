// 各岗位 SOP 初稿 (按 Frank 10-28 / 10-29 定下的流程写; 中方在「培训与 SOP」里随时改, 改了自动升版本、员工要重新确认).
// 每一步可以挂系统页面 (route), 员工点一下就到对应的地方 —— 这就是「流程联动」.
// 中法双语: 本地员工看法语, 中方看中文.
export const SOP_DEFAULTS = [
  { dept: '热线', title: '接单到客户确认 · Prise de commande', steps: [
    { text: '客户 WhatsApp / 电话要货：选客户 → 先选种类再选型号 → 填数量，保存报价单。没编码的型号点「补录需求」。 · Choisir le client, la catégorie puis le modèle, saisir la quantité et enregistrer le devis. Modèle inconnu : « 补录需求 ».', route: 'quote/new' },
    { text: '「复制图片」或「复制文字」发给客户；客户选好后点「热线确认」（不用凭证）。 · Copier l’image ou le texte et l’envoyer au client ; après son choix, « 热线确认 » (sans preuve).', route: 'orders' },
    { text: '主管出了销售订单后，发销售单给客户，拿到确认截图，填约定发货日，点「客户已确认」。 · Envoyer le bon de commande, joindre la capture de confirmation, saisir la date de livraison convenue.', route: 'todo' },
    { text: '复检少了货会退回「待客户确认」，只有变动的行标出来，只确认变动部分。 · Si le contrôle trouve moins, seules les lignes modifiées reviennent pour reconfirmation.' },
    { text: '客户说付了：在「资金账户」点「客户说付了」，上传付款截图。不要自己冲账。 · Client dit avoir payé : « 客户说付了 » avec la capture ; ne pas affecter le paiement soi-même.', route: 'cash' },
  ] },
  { dept: '热线', title: '每日回访 · Relances quotidiennes', steps: [
    { text: '每天打开「热线回访 → 今天要打」，备件、回收分开打。 · Ouvrir « 今天要打 » chaque jour ; pièces et recyclage séparés.', route: 'hotline' },
    { text: '打完点「记结果」：选结果，没接 / 忙 / 以后再要一定选下次跟进日期。 · Après l’appel : choisir le résultat et la date de relance si pas de réponse / occupé / plus tard.' },
    { text: '客户要下单：直接去新建报价。 · Le client commande : créer un devis directement.', route: 'quote/new' },
  ] },
  { dept: '仓库', title: '找货与初拣 · Préparation', steps: [
    { text: '「我的待办」里打开找货单，按库位找货。货已预占，不要拿给别的单。 · Ouvrir le bon de préparation dans « 我的待办 » ; le stock est réservé, ne pas le donner à une autre commande.', route: 'todo' },
    { text: '「实际供货」那一列填真找到的数；少了要选原因。 · Saisir la quantité réellement trouvée ; si moins, choisir la raison.' },
    { text: '货摆在地上拍照（相机坏了可以选图库或粘贴截图），选找货人，点「初拣完成」。 · Photographier la marchandise au sol, choisir le préparateur, valider.' },
  ] },
  { dept: '仓库', title: '复检打包与出库 · Contrôle, emballage, sortie', steps: [
    { text: '客户确认后主管复检：抽查，有问题的行写实际数和说明；拍打包照片。 · Après accord client, contrôle par le chef : quantités réelles, photo de l’emballage.', route: 'todo' },
    { text: '少了货：系统退回热线，只让客户重确认变动的行；多出来的货放回货架。 · Si moins : retour à la hotline pour les lignes modifiées ; remettre le surplus en rayon.' },
    { text: '出库必填：方式（Yango 摩托 / 小车 / 货车、自取、员工送）、电话、收货人、凭证截图。可以分批。 · Sortie : mode, téléphone, destinataire, capture obligatoire. Livraison partielle possible.' },
    { text: '发货失败或退回：点「发货失败 / 退回」，货回库并重新预占。 · Échec de livraison : « 发货失败 / 退回 », le stock revient réservé.' },
    { text: '到货入库只能进 LA 仓或 9S 仓；待检、回收、报废仓的货永远不参与配货。 · Réception uniquement en LA ou 9S ; les stocks en attente / recyclage / rebut ne sont jamais utilisés.', route: 'replenish' },
  ] },
  { dept: '财务', title: '收款与冲账 · Encaissements', steps: [
    { text: '门店当面收现金：在订单「收款」一步直接收，默认冲本单。 · Espèces au magasin : encaisser dans l’étape « 收款 » de la commande.', route: 'orders' },
    { text: '隔天付款或一次付多单：「收款与冲账」先选客户，默认冲最老的单。 · Paiement différé / plusieurs commandes : « 收款与冲账 », par défaut la plus ancienne.', route: 'receipts' },
    { text: '公户到账：在「资金账户」登记到账或导入银行流水，等中方认领，财务不自己认领。 · Virement sur le compte : enregistrer ou importer le relevé ; l’affectation au client est faite par la direction.', route: 'cash' },
    { text: '每次出库或退货后，把最新 Balance 发到客户群。 · Après chaque sortie ou retour, envoyer la Balance à jour au groupe du client.', route: 'balances' },
  ] },
  { dept: '财务', title: '公户与交款 · Compte et remises', steps: [
    { text: '公户持有人手上不能超过 500 万 XOF，最多压 7 天；超了马上交。 · Le détenteur ne garde jamais plus de 5 000 000 XOF ni plus de 7 jours.', route: 'cash' },
    { text: '交款：点「交款」上传凭证，中方确认收到才算交了。 · Remise : « 交款 » avec preuve ; validée seulement quand la direction confirme la réception.' },
    { text: '支出：选科目、上传凭证；超过审批线要中方批。 · Dépense : catégorie + preuve ; au-delà du seuil, validation de la direction.' },
  ] },
  { dept: '销售', title: '拜访新店 · Visite de nouveaux magasins', steps: [
    { text: '每次上门填一张拜访：门店照片必拍，新店直接建潜客（自动临时编码）。 · Chaque visite : photo obligatoire, nouveau magasin = prospect avec code temporaire.', route: 'visits' },
    { text: '记下想要的货、月用量、现在从哪买、怎么拿货。 · Noter produits recherchés, quantité mensuelle, fournisseur actuel, transport.' },
    { text: '转正式客户、定档位、给赊账由中方定，销售不承诺价格。 · Passage en client officiel, niveau de prix et crédit : décision de la direction uniquement.' },
  ] },
  { dept: '主管', title: '主管每日检查 · Contrôles du chef d’entrepôt', steps: [
    { text: '看「我的待办」：下推找货单、出销售订单、复检打包、出库。 · Vérifier « 我的待办 » : préparation, bon de commande, contrôle, sortie.', route: 'todo' },
    { text: '客户签收后，在「金蝶同步」保存（填金蝶单号）→ 提交；审核由另一个人做。 · Après réception client : saisie Kingdee (numéro) → soumission ; l’approbation par une autre personne.', route: 'kingdee' },
    { text: '撤回下推必须选原因；作废的单可以恢复。 · Tout retour en arrière exige une raison ; une commande annulée peut être restaurée.' },
  ] },
  { dept: '全员', title: '底线规则 · Règles de base', steps: [
    { text: '售价、特价、赊账只有中方能定。 · Prix, remises et crédit : uniquement la direction.' },
    { text: '给客户的单据不写公司地址、电话。 · Jamais d’adresse ni de téléphone de la société sur les documents clients.' },
    { text: '凭证不能拿旧图冒充，系统会提示同一张图用过。 · Ne jamais réutiliser une ancienne photo comme preuve ; le système le détecte.' },
  ] },
];

export async function seedSops(as, admin, org) {
  for (const s of SOP_DEFAULTS) {
    await as(admin, `select app.upsert_sop($1,null,$2,$3,$4,null)`, [org, s.dept, s.title, JSON.stringify(s.steps)]);
  }
}
