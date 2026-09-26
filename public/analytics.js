/* Shared teaching-site analytics, version 1.0.0. Never records input values. */
(function () {
  'use strict';
  const script = document.currentScript;
  if (!script || window.top !== window.self || !/^https?:$/.test(location.protocol) || /^(localhost|127\.0\.0\.1)$/.test(location.hostname) || window.__labAnalytics) return;
  const id = script.dataset.gaId;
  if (!/^G-[A-Z0-9]+$/.test(id || '')) return;
  const project = script.dataset.project || location.pathname.split('/').filter(Boolean)[0] || 'academic-site';
  const cleanURL = value => { if (!value) return ''; try { const url = new URL(value, location.href); return /^https?:$/.test(url.protocol) ? url.origin + url.pathname : ''; } catch (_) { return ''; } };
  if (typeof window.gtag !== 'function') {
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag('js', new Date());
    window.gtag('config', id, {page_location: cleanURL(location.href), page_referrer: cleanURL(document.referrer || ''), allow_google_signals: false, allow_ad_personalization_signals: false});
    const loader = document.createElement('script');
    loader.async = true;
    loader.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(id);
    document.head.append(loader);
  }
  const slug = value => /^[a-zA-Z0-9_./-]{1,100}$/.test(value || '') ? value : undefined;
  function send(name, parameters) {
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(name)) return;
    window.gtag('event', name, Object.assign({send_to: id, project_id: project, activity_id: location.pathname, transport_type: 'beacon'}, parameters));
  }
  window.__labAnalytics = {version: '1.0.0'};
  let started = false;
  const once = new Set();
  function start(target) {
    if (!started && target.closest('main, [role="main"], #ame-district, #app, #root') && !target.closest('header, nav, footer')) {
      started = true;
      send('activity_start', {});
    }
  }
  function labDestination(url) {
    if (url.hostname === 'desenlin.com') return /^(\/housing-market-lab|\/site-feasibility-sandbox|\/ame-quarter|\/FIN351|\/FIN355)(\/|$)/.exec(url.pathname)?.[1].slice(1);
    if (url.hostname === 'linguistics-teaching-labs.github.io') return url.pathname.split('/').filter(Boolean)[0] || 'linguistics-teaching-labs';
    return undefined;
  }
  function action(event) {
    if (!event.isTrusted || !(event.target instanceof Element)) return;
    const target = event.target;
    if (target.closest('button, select, input, canvas, [role="button"], [role="application"]')) start(target);
    const element = target.closest('[data-analytics-action]');
    if (element) {
      const isField = element.matches('input, select, textarea');
      if ((isField && event.type === 'change') || (!isField && event.type === 'click')) {
        const name = element.dataset.analyticsAction;
        const key = name + ':' + (element.id || element.dataset.analyticsValue || '');
        if (element.dataset.analyticsOnce !== 'true' || !once.has(key)) {
          once.add(key);
          // Values are fixed author-defined labels; select values require an explicit allowlist.
          const allowed = (element.dataset.analyticsAllowed || '').split(',');
          const value = isField && allowed.includes(element.value) ? slug(element.value) : slug(element.dataset.analyticsValue);
          send(name, value ? {action_value: value} : {});
        }
      }
    }
    if (event.type !== 'click') return;
    const link = target.closest('a[href]');
    if (!link) return;
    let url;
    try { url = new URL(link.href); } catch (_) { return; }
    const destination = labDestination(url);
    const parameters = {link_location: slug(link.dataset.analyticsLocation) || location.pathname, link_url: cleanURL(url.href)};
    if (destination && cleanURL(url.href) !== cleanURL(location.href)) send('lab_launch', Object.assign({lab_id: destination}, parameters));
    // Keep existing named launch events for continuity with older reports.
    if (link.dataset.analyticsEvent) send(link.dataset.analyticsEvent, parameters);
  }
  document.addEventListener('click', action, true);
  document.addEventListener('change', action, true);
})();
