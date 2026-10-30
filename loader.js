(() => {
      if (document.querySelector('meta[name="luna-auth"]')?.content === 'oauth') {
        document.getElementById("legacyLogin").hidden = true;
        document.getElementById("githubLoginBtn").hidden = false;
        document.getElementById("oauthNotice").textContent = "Подготовка входа через GitHub…";
      }
      const button = document.getElementById("connectBtn");
      const error = document.getElementById("loginError");
      const reload = document.getElementById("reloadBtn");
      let ready = false;
      const showStartupError = () => {
        if (ready) return;
        button.disabled = true;
        button.textContent = "luna не загрузилась";
        error.textContent = "Не удалось загрузить приложение. Проверь соединение и нажми «Обновить страницу». Если ошибка повторяется, попробуй Ctrl+Shift+R.";
        reload.hidden = false;
      };
      reload.onclick = () => location.reload();
      const timer = setTimeout(showStartupError, 20000);
      import("./app.js?v=luna-local-1").then(app => {
        clearTimeout(timer);
        ready = true;
        error.textContent = "";
        reload.hidden = true;
        button.disabled = false;
        button.textContent = "Открыть luna";
        app.restoreSession();
      }).catch(() => {
        clearTimeout(timer);
        showStartupError();
      });
    })();
