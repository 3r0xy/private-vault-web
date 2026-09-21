# note v1.4 final

Личный web-vault на GitHub Pages с хранением заметок и вложений в отдельном private GitHub repository.

## Файлы приложения

- `index.html` — интерфейс
- `styles.css` — стили
- `app-v1.4.js` — логика note
- `docs/01_Установка_note_на_GitHub_и_обновление_токена.pdf` — полная установка, Pages, token и его обновление
- `docs/02_Вход_с_разных_устройств_и_работа_с_note.pdf` — вход на компьютере/планшете и использование note

## Текущая конфигурация

- GitHub owner: `3r0xy`
- Web repository: `private-vault-web`
- Private vault repository: `my-private-vault`
- URL: `https://3r0xy.github.io/private-vault-web/`

## Обновление сайта

В `private-vault-web` загрузить/заменить `index.html`, `styles.css`, `app-v1.4.js`, сделать Commit changes и дождаться GitHub Pages deployment. Затем выполнить hard refresh браузера (`Ctrl + Shift + R`).

## Vault size

В нижней строке состояния показана ненавязчивая плашка `Vault: X / 10 GB`. Это приблизительная сумма текущих файлов, видимых через GitHub tree API. `10 GB` — рекомендованный GitHub ориентир размера репозитория, а не квота бесплатного тарифа; история Git может занимать дополнительное место.

## Безопасность

Токен не должен попадать в этот public-репозиторий. Используй fine-grained token только для `my-private-vault` с разрешением `Contents: Read and write` и храни его в менеджере паролей.
