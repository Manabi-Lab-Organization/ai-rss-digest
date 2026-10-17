# 使っているソフトのライセンス

AI RSS Digest は、多くのオープンソースのソフトを使っています。この文書は `package-lock.json` から集計したものです（他の OS 用の部品など、実際には入らないものも含みます）。各ソフトの著作権表示とライセンスの全文は、`npm ci` のあとの `node_modules/<名前>/` にある LICENSE などのファイルにあります。

## アプリと一緒に動くもの

サーバで動く部品と、画面（ブラウザ）に組み込まれる部品です。Docker のイメージには、これらが入ります。

| ライセンス | パッケージの数 |
|---|---|
| MIT | 278 |
| Apache-2.0 | 33 |
| ISC | 8 |
| BSD-3-Clause | 4 |
| BSD-2-Clause | 2 |
| Unlicense | 2 |
| BlueOak-1.0.0 | 2 |
| MIT-0 | 1 |
| 0BSD | 1 |

- **Unlicense**：`fast-sha256`・`wouter`。著作権を放棄し、誰でも自由に使えるとするライセンスです。
- **BlueOak-1.0.0**：`isexe`・`sax`。MIT などと同じく、著作権表示を残せば自由に使えるライセンスです。
- **MIT-0**：`postal-mime`。著作権表示を残す義務も無い MIT です。

いずれも、Apache License 2.0 で配るこのソフトと一緒に使える条件です。

## 開発とビルドのときだけ使うもの

型の確認・テスト・画面のビルドなどに使い、Docker のイメージには入りません。

| ライセンス | パッケージの数 |
|---|---|
| MIT | 190 |
| ISC | 12 |
| Apache-2.0 | 6 |
| CC-BY-4.0 | 1 |
| BSD-3-Clause | 1 |

- **CC-BY-4.0**：`caniuse-lite`（ブラウザの対応状況のデータ）。画面のビルドのときに読むだけで、できあがった画面には入りません。

## Docker のイメージに入るそのほかのソフト

`docker compose` を実行すると、各社のサーバで次のものを取得してイメージを作ります。このリポジトリには、これらのソフトそのものは含まれていません。

| ソフト | 取得元 | ライセンス |
|---|---|---|
| Node.js | `node:22-bookworm-slim` のイメージ | MIT など（Node.js に同梱の部品のライセンスを含む） |
| Debian の基本の部品 | 同上（Debian 12） | 部品ごとに GPL・LGPL・BSD など |
| ffmpeg | Debian のパッケージ（`Dockerfile` の `apt-get install ffmpeg`） | 下の説明を参照 |
| PostgreSQL | `postgres:16` のイメージ | PostgreSQL License |
| Caddy（A の立ち上げ方のときだけ） | `caddy:2` のイメージ | Apache-2.0 |

### ffmpeg について

- 音声版の音声を mp3 に変えるために使います。アプリは ffmpeg を別のプログラムとして呼び出すだけで、アプリの中に組み込んで（リンクして）はいません。
- ffmpeg 自体は LGPL 2.1 以降ですが、Debian のパッケージは GPL の条件が付く部品も有効にしてビルドされているため、全体として GPL 2 以降の条件で配られています。正確な条件は、イメージの中の `/usr/share/doc/ffmpeg/copyright` と、`docker compose exec app ffmpeg -version` に出るビルドの設定で確かめられます。
- ffmpeg はイメージを作るときに Debian から取得するもので、このリポジトリからは配っていません。**作ったイメージを他の人に配る場合は**、ffmpeg などのソースを手に入れられるようにするといった、GPL などの条件を各社で守ってください（Debian のソースは Debian のサイトから入手できます）。

## 一覧（アプリと一緒に動くもの）

### MIT

@esbuild-kit/core-utils、@esbuild-kit/esm-loader、@esbuild/aix-ppc64、@esbuild/android-arm、@esbuild/android-arm64、@esbuild/android-x64、@esbuild/darwin-arm64、@esbuild/darwin-x64、@esbuild/freebsd-arm64、@esbuild/freebsd-x64、@esbuild/linux-arm、@esbuild/linux-arm64、@esbuild/linux-ia32、@esbuild/linux-loong64、@esbuild/linux-mips64el、@esbuild/linux-ppc64、@esbuild/linux-riscv64、@esbuild/linux-s390x、@esbuild/linux-x64、@esbuild/netbsd-x64、@esbuild/openbsd-x64、@esbuild/sunos-x64、@esbuild/win32-arm64、@esbuild/win32-ia32、@esbuild/win32-x64、@floating-ui/core、@floating-ui/dom、@floating-ui/react-dom、@floating-ui/utils、@petamoriken/float16、@radix-ui/primitive、@radix-ui/react-arrow、@radix-ui/react-collection、@radix-ui/react-compose-refs、@radix-ui/react-context、@radix-ui/react-dialog、@radix-ui/react-direction、@radix-ui/react-dismissable-layer、@radix-ui/react-dropdown-menu、@radix-ui/react-focus-guards、@radix-ui/react-focus-scope、@radix-ui/react-id、@radix-ui/react-menu、@radix-ui/react-popper、@radix-ui/react-portal、@radix-ui/react-presence、@radix-ui/react-primitive、@radix-ui/react-roving-focus、@radix-ui/react-slot、@radix-ui/react-tabs、@radix-ui/react-toast、@radix-ui/react-use-callback-ref、@radix-ui/react-use-controllable-state、@radix-ui/react-use-effect-event、@radix-ui/react-use-escape-keydown、@radix-ui/react-use-layout-effect、@radix-ui/react-use-rect、@radix-ui/react-use-size、@radix-ui/react-visually-hidden、@radix-ui/rect、@stablelib/base64、@tanstack/query-core、@tanstack/react-query、@types/debug、@types/estree、@types/estree-jsx、@types/hast、@types/mdast、@types/ms、@types/prop-types、@types/react、@types/unist、accepts、agent-base、aria-hidden、array-flatten、bail、base64-js、bignumber.js、body-parser、bowser、buffer-from、bytes、call-bind-apply-helpers、call-bound、ccount、character-entities、character-entities-html4、character-entities-legacy、character-reference-invalid、clsx、comma-separated-tokens、connect-pg-simple、content-disposition、content-type、cookie、cookie-signature、cors、csstype、data-uri-to-buffer、debug、decode-named-character-reference、depd、dequal、destroy、detect-node-es、devlop、drizzle-kit、dunder-proto、ee-first、encodeurl、env-paths、es-define-property、es-errors、es-object-atoms、esbuild、esbuild-register、escape-html、estree-util-is-identifier-name、etag、express、express-rate-limit、express-session、extend、fetch-blob、finalhandler、formdata-polyfill、forwarded、fresh、function-bind、get-intrinsic、get-nonce、get-proto、get-tsconfig、gopd、has-symbols、hasown、hast-util-to-jsx-runtime、hast-util-whitespace、helmet、html-url-attributes、http-errors、https-proxy-agent、iconv-lite、inline-style-parser、ip-address、ipaddr.js、is-alphabetical、is-alphanumerical、is-decimal、is-hexadecimal、is-plain-obj、js-tokens、json-bigint、jwa、jws、longest-streak、loose-envify、math-intrinsics、mdast-util-from-markdown、mdast-util-mdx-expression、mdast-util-mdx-jsx、mdast-util-mdxjs-esm、mdast-util-phrasing、mdast-util-to-hast、mdast-util-to-markdown、mdast-util-to-string、media-typer、merge-descriptors、methods、micromark、micromark-core-commonmark、micromark-factory-destination、micromark-factory-label、micromark-factory-space、micromark-factory-title、micromark-factory-whitespace、micromark-util-character、micromark-util-chunked、micromark-util-classify-character、micromark-util-combine-extensions、micromark-util-decode-numeric-character-reference、micromark-util-decode-string、micromark-util-encode、micromark-util-html-tag-name、micromark-util-normalize-identifier、micromark-util-resolve-all、micromark-util-sanitize-uri、micromark-util-subtokenize、micromark-util-symbol、micromark-util-types、mime、mime-db、mime-types、mitt、ms、negotiator、node-domexception、node-fetch、object-assign、object-inspect、on-finished、on-headers、parse-entities、parseurl、path-to-regexp、pg、pg-cloudflare、pg-connection-string、pg-pool、pg-protocol、pg-types、pgpass、postgres-array、postgres-bytea、postgres-date、postgres-interval、property-information、proxy-addr、random-bytes、range-parser、raw-body、react、react-dom、react-markdown、react-remove-scroll、react-remove-scroll-bar、react-style-singleton、regexparam、remark-parse、remark-rehype、resend、resolve-pkg-maps、rss-parser、safe-buffer、safer-buffer、scheduler、send、serve-static、shell-quote、side-channel、side-channel-list、side-channel-map、side-channel-weakmap、source-map-support、space-separated-tokens、standardwebhooks、statuses、stringify-entities、style-to-js、style-to-object、tailwind-merge、toidentifier、trim-lines、trough、type-is、uid-safe、undici、unified、unist-util-is、unist-util-position、unist-util-stringify-position、unist-util-visit、unist-util-visit-parents、unpipe、use-callback-ref、use-sidecar、use-sync-external-store、utils-merge、vary、vfile、vfile-message、web-streams-polyfill、xml2js、xmlbuilder、xtend、zod、zwitch

### Apache-2.0

@aws-sdk/checksums、@aws-sdk/client-s3、@aws-sdk/core、@aws-sdk/credential-provider-env、@aws-sdk/credential-provider-http、@aws-sdk/credential-provider-ini、@aws-sdk/credential-provider-login、@aws-sdk/credential-provider-node、@aws-sdk/credential-provider-process、@aws-sdk/credential-provider-sso、@aws-sdk/credential-provider-web-identity、@aws-sdk/middleware-sdk-s3、@aws-sdk/nested-clients、@aws-sdk/signature-v4-multi-region、@aws-sdk/token-providers、@aws-sdk/types、@aws-sdk/xml-builder、@aws/lambda-invoke-store、@drizzle-team/brocli、@smithy/core、@smithy/credential-provider-imds、@smithy/fetch-http-handler、@smithy/node-http-handler、@smithy/signature-v4、@smithy/types、class-variance-authority、drizzle-orm、ecdsa-sig-formatter、gaxios、gcp-metadata、gel、google-auth-library、google-logging-utils

### ISC

@ungap/structured-clone、inherits、lucide-react、pg-int8、semver、setprototypeof、split2、which

### BSD-3-Clause

bcryptjs、buffer-equal-constant-time、qs、source-map

### BSD-2-Clause

dotenv、entities

### Unlicense

fast-sha256、wouter

### BlueOak-1.0.0

isexe、sax

### MIT-0

postal-mime

### 0BSD

tslib
