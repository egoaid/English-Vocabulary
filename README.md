# English Reading Practice (PWA)

**公開URL：** https://egoaid.github.io/English-Vocabulary/

## GitHub Pagesでの公開手順

1. GitHubで新しいリポジトリを作成する（例：`english-reading-practice`）。
2. このフォルダの中身をリポジトリの**ルート**にそのままアップロードする（フォルダ構成を維持したまま）。
   - `index.html` はルート直下に置いてください（サブフォルダに入れると `manifest.json` や `sw.js` のパスがずれます）。
   - `data/` フォルダ（`words.json`, `idioms.json`）も忘れずにアップロードしてください。
3. GitHubのリポジトリ設定 → **Pages** → Source を「Deploy from a branch」にし、対象ブランチ（例：`main`）とフォルダ（`/root`）を選択して保存する。
4. 数分後、`https://<ユーザー名>.github.io/<リポジトリ名>/` でアクセスできるようになります。

## PWA（ホーム画面に追加）

- スマホでサイトを開き、ブラウザの「ホーム画面に追加」（Android: Chromeのメニュー／iOS: Safariの共有メニュー）を選ぶと、アプリのように起動できます。
- オフラインでも一度開いたページはある程度閲覧できます（Service Workerによるキャッシュ）。

## 機能メモ

- `index.html` を開くと、カテゴリ別の目次（ホーム画面）が表示されます。カードをクリックすると各カテゴリのページに移動します。
- 画面左上の ☰ アイコン：全カテゴリ横断のサイドバー目次を開閉します（別カテゴリへもここから直接ジャンプできます）。
- 画面右上の ⚙️ アイコン：設定パネルを開閉します（印刷、読み上げ速度、フルスクリーン暗記モードの見た目、フラッシュカード速度など）。
- 設定パネル内の「📖 使い方マニュアル」から、操作方法の説明を確認できます。
- スマートフォン幅（700px以下）で表示すると、Partごとに1画面になり、左右スワイプでページ送りできます。
- Part 50・51（単語帳・熟語帳）は `data/words.json` / `data/idioms.json` を読み込んで表示します。各ランク見出しの🎴ボタンからフラッシュカード全画面モードも使えます。

## ファイル構成

```
index.html          ホーム（カテゴリ目次）
reading-1.html       Part 1〜29：時事・社会トピック読解
reading-2.html       Part 30〜34：物語文
reading-3.html       Part 35〜39：論説文解釈
reading-4.html       Part 40〜44：英作文練習
reading-5.html       Part 45〜49：リスニング対策
vocab-words.html      Part 50：重要英単語ランク表（data/words.json を読み込み）
vocab-idioms.html     Part 51：重要熟語・イディオムランク表（data/idioms.json を読み込み）
styles.css           全ページ共通CSS
app.js               全ページ共通JavaScript（読み上げ・フルスクリーン暗記モード・設定など）
data/words.json      重要英単語データ（ランクA〜E、全1900語）
data/idioms.json     重要熟語データ（ランクA〜E、全1000熟語）
manifest.json        PWA設定
sw.js                Service Worker（オフラインキャッシュ）
icons/               PWAアイコン（192px, 512px）
```

### 単語帳・熟語帳データの更新について

`data/words.json` と `data/idioms.json` は、以下の形式のシンプルなJSONです。ページのHTMLを触らずに、この2ファイルを編集するだけで単語・熟語の追加や訳の修正ができます。

```json
{
  "title": "重要英単語ランク表",
  "unit": "語",
  "ranks": [
    { "letter": "A", "desc": "最重要・超基本語", "items": [["create", "生み出す"], ["increase", "増える"]] }
  ]
}
```
