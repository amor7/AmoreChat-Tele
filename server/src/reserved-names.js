// Names nobody can take by themselves, so nobody poses as the server's staff, a company or an
// institution. Read once, when the database is first upgraded; after that the owner edits the
// list in the panel (and can release a name, or give it to a user).
const GROUPS = {
  staff: `admin admins administrator root system sysadmin support helpdesk help info official staff team service services
    security abuse report reports contact sales billing payment payments wallet bank verify verified verification
    server bot bots robot moderators manager management ceo founder postmaster webmaster hostmaster noreply no_reply
    mail email news newsletter update updates alert alerts emergency
    amore amorechat amore_chat amorechatofficial amorechat_support amorechat_admin amoretele`,
  tech: `google gmail youtube android chrome alphabet deepmind gemini apple icloud iphone ipad macos itunes microsoft windows
    azure office outlook xbox linkedin github gitlab bitbucket skype teams bing copilot meta facebook instagram whatsapp
    threads messenger oculus amazon aws kindle twitch alexa netflix disney hulu spotify soundcloud tiktok bytedance
    snapchat twitter xcom pinterest reddit tumblr quora discord slack zoom dropbox notion figma canva adobe photoshop
    openai chatgpt anthropic claude midjourney perplexity deepseek mistral nvidia intel amd arm qualcomm broadcom cisco
    oracle ibm sap salesforce shopify stripe paypal visa mastercard amex wise revolut samsung huawei xiaomi oppo vivo
    oneplus realme nokia sony lg lenovo asus acer dell hp logitech razer canon nikon tesla spacex starlink neuralink
    telegram telegraph durov signal viber line wechat qq weibo alibaba aliexpress tencent baidu temu shein ebay etsy
    walmart ikea uber lyft airbnb booking expedia tripadvisor wikipedia wikimedia mozilla firefox opera brave duckduckgo
    yahoo yandex protonmail proton cloudflare akamai digitalocean hetzner ovh vercel netlify docker kubernetes ubuntu
    debian redhat linux python nodejs npmjs steam valve epicgames fortnite roblox minecraft mojang blizzard ubisoft
    nintendo playstation riotgames pubg freefire binance coinbase kraken bybit kucoin okx tether bitcoin ethereum
    metamask trustwallet`,
  world: `coca_cola cocacola pepsi nestle unilever samsonite adidas nike puma reebok gucci prada chanel dior rolex zara
    bmw mercedes audi porsche ferrari lamborghini toyota honda nissan hyundai kia ford volkswagen renault peugeot volvo
    mcdonalds kfc starbucks burgerking dominos fifa uefa nba nfl olympics realmadrid barcelona manutd manchesterunited
    liverpool chelsea arsenal juventus bayern psg acmilan intermilan cnn bbc bbcpersian foxnews reuters nytimes
    guardian aljazeera euronews bloomberg forbes wsj nasa unesco unicef who_int redcross un_org worldbank imf nato
    interpol`,
  iranOrgs: `iran irna isna mehrnews tasnim farsnews tabnak khabaronline hamshahri irib iribnews presstv mizan yjc
    shargh etemad keyhan jamejam varzesh3 navad football360 persianleague ffiri
    president parliament majlis government dolat police fata ansar sepah artesh
    ministry mfa_ir moi_ir medu_ir behdasht tamin_ejtemaei sabtahval sanjesh samt irica shaparak shetab cbi_ir
    tehran mashhad isfahan shiraz tabriz karaj ahvaz qom
    perspolis persepolis esteghlal sepahan tractor foolad
    sharif ut_ac_ir tums aut_ac_ir iust modares`,
  iranBrands: `digikala digistyle digipay snapp snappfood snappbox snappmarket snapppay snappshop snapptrip tapsi tapsifood
    maxim divar sheypoor bama aparat filimo namava telewebion cafebazaar bazaar myket rubika eitaa soroush bale gap igap
    splus shad balemessenger virgool ninisite torob basalam timcheh okala banimode
    irancell mci hamrahaval hamrahavval rightel shatel mobinnet asiatech pishgaman parsonline arvancloud parspack
    tosan zarinpal idpay payping zibal saman parsian bankmellat mellat melli sepah_bank bankmaskan maskan keshavarzi
    tejarat saderat bankmelli ayandeh pasargad bankpasargad refah mehriran resalat sina shahr blubank bluebank
    nobitex wallex bitpin tabdeal ramzinex excoino irankhodro saipa kermanmotor bahman mapna golrang chitooz kalleh
    pegah mihan zarmacaron iranair mahanair kishair qeshmair alibaba_ir flytoday jabama jajiga otaghak bimeh_iran
    alborz_insurance dana_insurance dey_insurance neshan balad snappcarfix hamrahcard bpm_ir sibche`,
};

export const RESERVED_NAMES = [
  ...new Set(
    Object.values(GROUPS)
      .join(' ')
      .split(/\s+/)
      .filter((n) => /^[a-zA-Z][a-zA-Z0-9_]{2,31}$/.test(n))
      .map((n) => n.toLowerCase()),
  ),
];
