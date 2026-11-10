(() => {
    'use strict';

    const initialiseLanguageSwitch = () => {
        const translations = new Map();
        const accessibleLabels = new Map();
        const buttons = {
            en: document.getElementById('btn-en'),
            zh: document.getElementById('btn-zh')
        };

        document.querySelectorAll('[data-zh]').forEach(element => {
            translations.set(element, element.localName === 'meta'
                ? element.getAttribute('content')
                : element.textContent);
        });

        document.querySelectorAll('[data-zh-aria-label]').forEach(element => {
            accessibleLabels.set(element, element.getAttribute('aria-label'));
        });

        const showLanguage = (requestedLanguage, remember = true) => {
            const language = requestedLanguage === 'zh' ? 'zh' : 'en';

            translations.forEach((english, element) => {
                const text = language === 'zh' ? element.dataset.zh : english;

                if (element.localName === 'meta') {
                    element.setAttribute('content', text);
                } else {
                    element.textContent = text;
                }
            });

            accessibleLabels.forEach((english, element) => {
                const label = language === 'zh' ? element.dataset.zhAriaLabel : english;
                if (label === null) {
                    element.removeAttribute('aria-label');
                } else {
                    element.setAttribute('aria-label', label);
                }
            });

            document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';

            Object.entries(buttons).forEach(([buttonLanguage, button]) => {
                if (button) {
                    const active = buttonLanguage === language;
                    button.classList.toggle('active', active);
                    button.setAttribute('aria-pressed', String(active));
                }
            });

            if (remember) {
                try {
                    window.localStorage.setItem('site-language', language);
                } catch {
                    // Switching still works when browser storage is unavailable.
                }
            }
        };

        Object.entries(buttons).forEach(([language, button]) => {
            button?.addEventListener('click', () => showLanguage(language));
        });

        let savedLanguage = 'en';
        try {
            savedLanguage = window.localStorage.getItem('site-language') || 'en';
        } catch {
            // Direct file previews and privacy settings may block storage.
        }

        showLanguage(savedLanguage, false);
        document.querySelectorAll('.lang-switch').forEach(switcher => {
            switcher.hidden = false;
        });
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialiseLanguageSwitch, { once: true });
    } else {
        initialiseLanguageSwitch();
    }
})();
