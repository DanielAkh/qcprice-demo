/*
 * Прайс Qazcontent: аккордеон панелей.
 *
 * Разметка (внутри .qc-price):
 *   <a class="qc-nav-card" href="#qc-baq" data-qc-toggle="baq">…</a>          карточка-переключатель
 *   <div class="qc-panel" id="qc-panel-baq" data-qc-panel="baq">
 *     <div class="qc-panel__inner"> …секции… </div>
 *   </div>
 * Новый блок — та же разметка с другим именем; JS менять не нужно.
 *
 * - Скрипт ставит на .qc-price класс qc-price--js — только тогда CSS скрывает панели
 *   (без JS всё видно, карточки работают как обычные якоря).
 * - Карточка получает role="button", aria-controls, aria-expanded; клик, Enter и Space
 *   открывают / закрывают панель (preventDefault — без перехода по href). Открыта одна
 *   панель на блок .qc-price: открытие другой закрывает текущую.
 * - Закрытая панель — атрибут inert (не в фокусе и не в дереве доступности).
 * - После открытия: если верх панели не виден (выше scroll-margin-top =
 *   --qc-anchor-offset) или ниже 60% высоты окна, плавная прокрутка — верх встаёт
 *   на --qc-anchor-offset.
 * - Хеш (#qc-baq, #qc-el-banners, … — любой id внутри панели) при загрузке и на
 *   hashchange открывает нужную панель и прокручивает к элементу.
 * - Всё в IIFE, глобальных имён нет; работает только внутри .qc-price. Блоки,
 *   вставленные позже (или вставленные заново), подхватываются MutationObserver;
 *   повторное подключение скрипта не навешивает обработчики второй раз.
 */
(function () {
  'use strict';

  var ROOT = '.qc-price';
  var ROOT_JS = 'qc-price--js';
  var PANEL_OPEN = 'qc-panel--open';
  var CARD_ACTIVE = 'qc-nav-card--active';
  // Метка «обработчики навешены» — свойство узла, а не атрибут: не попадает в HTML
  // при копировании блока и общая для двух копий скрипта на странице.
  var READY = 'qcPriceReady';

  // Отложенная прокрутка панели: panel → функция отмены
  var pending = new WeakMap();

  function each(list, fn) {
    Array.prototype.forEach.call(list, fn);
  }

  function reducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function attrValue(s) {
    return String(s).replace(/["\\]/g, '\\$&');
  }

  function panelByName(root, name) {
    return root.querySelector('[data-qc-panel="' + attrValue(name) + '"]');
  }

  function cardsByName(root, name) {
    return root.querySelectorAll('[data-qc-toggle="' + attrValue(name) + '"]');
  }

  // Панели, у которых есть хотя бы одна карточка: только они участвуют в аккордеоне
  function collapsiblePanels(root) {
    var out = [];
    each(root.querySelectorAll('[data-qc-panel]'), function (panel) {
      if (cardsByName(root, panel.getAttribute('data-qc-panel')).length) out.push(panel);
    });
    return out;
  }

  // Длительность анимации высоты (0 при prefers-reduced-motion), мс
  function duration(panel) {
    var s = parseFloat(window.getComputedStyle(panel).transitionDuration) || 0;
    return s * 1000;
  }

  // Изменение без анимации: загрузка страницы, открытие по хешу при загрузке
  function instantly(panels, fn) {
    var els = [];
    panels.forEach(function (p) {
      els.push(p);
      if (p.firstElementChild) els.push(p.firstElementChild);
    });
    els.forEach(function (el) { el.style.transition = 'none'; });
    fn();
    if (els.length) void els[0].offsetHeight; // применить стили до возврата анимации
    els.forEach(function (el) { el.style.transition = ''; });
  }

  function cancelPending(panel) {
    var cancel = pending.get(panel);
    if (cancel) cancel();
  }

  function setOpen(root, panel, open) {
    cancelPending(panel);
    panel.classList.toggle(PANEL_OPEN, open);
    if (open) panel.removeAttribute('inert');
    else panel.setAttribute('inert', '');
    each(cardsByName(root, panel.getAttribute('data-qc-panel')), function (card) {
      card.classList.toggle(CARD_ACTIVE, open);
      card.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }

  // Открыть одну панель, остальные закрыть
  function openOnly(root, panel) {
    collapsiblePanels(root).forEach(function (p) {
      if (p !== panel && p.classList.contains(PANEL_OPEN)) setOpen(root, p, false);
    });
    setOpen(root, panel, true);
  }

  // Верх элемента «на виду»: ниже фиксированной шапки (scroll-margin-top) и в верхних
  // TOP_ZONE высоты окна. Ниже этой линии от панели видно слишком мало (вплоть до доли
  // пикселя у самого низа окна, когда карточка стоит у нижнего края) — прокручиваем.
  var TOP_ZONE = 0.6;

  function topVisible(el) {
    var top = el.getBoundingClientRect().top;
    var offset = parseFloat(window.getComputedStyle(el).scrollMarginTop) || 0;
    return top >= offset && top <= window.innerHeight * TOP_ZONE;
  }

  // После окончания анимации (позиции уже итоговые, в т. ч. у закрывшейся соседней
  // панели выше) прокрутить к target; force — всегда (переход по хешу), иначе — только
  // если верх не на виду (topVisible). Ждём transitionend и ещё кадр: пока высота растёт, браузер
  // подправляет прокрутку (scroll anchoring), и прокрутка по таймеру могла сработать
  // на кадр раньше конца анимации. Таймер — запасной вариант, если transitionend не
  // придёт. Повторный клик до конца анимации отменяет прокрутку.
  function scrollAfterOpen(panel, target, force) {
    cancelPending(panel);
    var timer = 0;
    var frame = 0;
    var onEnd = function (e) {
      if (e.target === panel && e.propertyName === 'grid-template-rows') run();
    };
    var cancel = function () {
      window.clearTimeout(timer);
      if (frame) window.cancelAnimationFrame(frame);
      panel.removeEventListener('transitionend', onEnd);
      if (pending.get(panel) === cancel) pending.delete(panel);
    };
    var run = function () {
      window.clearTimeout(timer);
      panel.removeEventListener('transitionend', onEnd);
      frame = window.requestAnimationFrame(function () {
        frame = 0;
        if (pending.get(panel) === cancel) pending.delete(panel);
        if (!panel.classList.contains(PANEL_OPEN)) return;
        if (!force && topVisible(target)) return;
        target.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
      });
    };
    var ms = duration(panel);
    if (ms > 0) panel.addEventListener('transitionend', onEnd);
    timer = window.setTimeout(run, ms > 0 ? ms + 100 : 0);
    pending.set(panel, cancel);
  }

  function toggle(root, name) {
    var panel = panelByName(root, name);
    if (!panel) return;
    if (panel.classList.contains(PANEL_OPEN)) {
      setOpen(root, panel, false);
    } else {
      openOnly(root, panel);
      scrollAfterOpen(panel, panel, false);
    }
  }

  // id из хеша внутри панели этого блока → открыть её; animate = false при загрузке
  function openFromHash(root, animate) {
    var id = window.location.hash.slice(1);
    if (!id) return;
    try { id = decodeURIComponent(id); } catch (e) { /* оставить как есть */ }
    var target = document.getElementById(id);
    if (!target || !root.contains(target)) return;
    var panel = target.closest('[data-qc-panel]');
    if (!panel || collapsiblePanels(root).indexOf(panel) < 0) return;

    if (!animate) {
      instantly(collapsiblePanels(root), function () { openOnly(root, panel); });
      target.scrollIntoView({ block: 'start' });
      return;
    }
    if (!panel.classList.contains(PANEL_OPEN)) openOnly(root, panel);
    scrollAfterOpen(panel, target, true);
  }

  function cardFromEvent(root, e) {
    var card = e.target.closest ? e.target.closest('[data-qc-toggle]') : null;
    if (!card || !root.contains(card) || !card.hasAttribute('aria-controls')) return null;
    return card;
  }

  function init(root) {
    if (root[READY]) return;

    var panels = collapsiblePanels(root);
    if (!panels.length) return;
    root[READY] = true;

    each(root.querySelectorAll('[data-qc-toggle]'), function (card) {
      var name = card.getAttribute('data-qc-toggle');
      var panel = panelByName(root, name);
      if (!panel) return; // карточка без панели остаётся обычной ссылкой
      if (!panel.id) panel.id = 'qc-panel-' + name;
      card.setAttribute('role', 'button');
      card.setAttribute('aria-controls', panel.id);
    });

    // Исходное состояние: все закрыты (в т. ч. если блок вставлен из сохранённого HTML)
    instantly(panels, function () {
      root.classList.add(ROOT_JS);
      panels.forEach(function (p) { setOpen(root, p, false); });
    });

    root.addEventListener('click', function (e) {
      // Ctrl/Shift/Cmd+клик и не левая кнопка — как у ссылки (новая вкладка с #хешем)
      if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      var card = cardFromEvent(root, e);
      if (!card) return;
      e.preventDefault();
      toggle(root, card.getAttribute('data-qc-toggle'));
    });

    root.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      var card = cardFromEvent(root, e);
      if (!card) return;
      e.preventDefault(); // Enter — без click по ссылке, Space — без прокрутки страницы
      if (!e.repeat) toggle(root, card.getAttribute('data-qc-toggle'));
    });

    openFromHash(root, false);
  }

  function initAll(scope) {
    if (scope.nodeType !== 1 && scope.nodeType !== 9) return;
    if (scope.nodeType === 1 && scope.matches(ROOT)) init(scope);
    each(scope.querySelectorAll(ROOT), init);
  }

  function start() {
    initAll(document);

    window.addEventListener('hashchange', function () {
      each(document.querySelectorAll(ROOT), function (root) {
        if (root[READY]) openFromHash(root, true);
      });
    });

    // Блок, вставленный позже (конструктор страниц, AJAX) или вставленный заново
    if (typeof MutationObserver === 'function') {
      new MutationObserver(function (records) {
        records.forEach(function (r) { each(r.addedNodes, initAll); });
      }).observe(document.documentElement, { childList: true, subtree: true });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
