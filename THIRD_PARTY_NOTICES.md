# Third-party notices

This file records third-party material used or redistributed by the project. It does not grant rights to the
DeepSeek name, logo, app icon, or other artwork, and it does not make this community launcher an official DeepSeek
product.

## DeepSeek Harness

DeepSeek Harness is distributed under the MIT License:

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of
the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

The MIT grant above applies to the DeepSeek Harness software covered by that license. It does not by itself license
DeepSeek trademarks or artwork.

## Microsoft Edge WebView2

Microsoft Edge WebView2 SDK notices are retained in `launcher/vendor/webview2/LICENSE.txt` and `NOTICE.txt` in the
source tree. Full release archives place copies at `licenses/WebView2/LICENSE.txt` and
`licenses/WebView2/NOTICE.txt`.

The Microsoft Edge WebView2 Runtime is a separate system prerequisite and is not bundled in this repository's full
or runtime-only archives.

## npm dependency closure

Full packages and runtime-only update archives redistribute the installed npm dependency closure required by the
pinned `@deepseek-ai/dsh` version. Each published archive must retain the license, copying, notice, and attribution
files shipped by those packages. Release staging should also contain generated inventories such as
`licenses/npm-packages.csv` and `licenses/npm-packages.json` when produced by the packaging workflow.

Package authors and license terms vary. The original license files in each package remain authoritative. Before a
release is published, the actual staged dependency tree—not only `package.json`—must be scanned and the resulting
license bundle reviewed.

## Launcher artwork

The current launcher icon source is derived from the official DeepSeek mobile app artwork retrieved from the Apple
App Store listing for `DeepSeek - AI Assistant` (`id6737597349`). Copyright and trademark rights in that artwork
remain with Hangzhou DeepSeek Artificial Intelligence Co., Ltd. The publisher has not documented a separate artwork
license. See `PUBLIC-RELEASE-NOTICE.md` before redistribution.

## Repository-owned material

Third-party notices do not establish a license for original launcher, updater, documentation, or packaging code in
this repository. Unless the repository owner adds a root `LICENSE` that expressly covers that material, no general
open-source license should be inferred for it.
