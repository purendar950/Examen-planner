(function () {
  'use strict';

  // ── Navbar scroll state ────────────────────────────────────────────────
  var navbar = document.getElementById('navbar');
  if (navbar) {
    var updateNav = function () {
      navbar.classList.toggle('scrolled', window.scrollY > 20);
    };
    updateNav();
    window.addEventListener('scroll', updateNav, { passive: true });
  }

  // ── Mobile nav toggle ──────────────────────────────────────────────────
  window.toggleMobileNav = function () {
    var nav = document.getElementById('mobileNav');
    var btn = document.getElementById('hamburger');
    if (!nav || !btn) return;
    var isOpen = nav.classList.toggle('active');
    btn.setAttribute('aria-expanded', String(isOpen));
    nav.setAttribute('aria-hidden', String(!isOpen));
  };

  window.closeMobileNav = function () {
    var nav = document.getElementById('mobileNav');
    var btn = document.getElementById('hamburger');
    if (nav) {
      nav.classList.remove('active');
      nav.setAttribute('aria-hidden', 'true');
    }
    if (btn) btn.setAttribute('aria-expanded', 'false');
  };

  // ── FAQ accordion (one open at a time) ────────────────────────────────
  window.toggleFaq = function (btn) {
    if (!btn) return;
    var item = btn.closest('.faq-item');
    if (!item) return;
    var wasActive = item.classList.contains('active');
    document.querySelectorAll('.faq-item.active').forEach(function (el) {
      el.classList.remove('active');
      var q = el.querySelector('.faq-question');
      if (q) q.setAttribute('aria-expanded', 'false');
    });
    if (!wasActive) {
      item.classList.add('active');
      btn.setAttribute('aria-expanded', 'true');
    }
  };

  // ── Smooth scroll for in-page anchors ──────────────────────────────────
  document.querySelectorAll('a[href^="#"]').forEach(function (link) {
    link.addEventListener('click', function (e) {
      var href = this.getAttribute('href');
      if (!href || href === '#' || href.length < 2) return;
      var target = document.querySelector(href);
      if (target) {
        e.preventDefault();
        var offset = 72; // fixed navbar
        var top = target.getBoundingClientRect().top + window.pageYOffset - offset;
        window.scrollTo({ top: top, behavior: 'smooth' });
      }
    });
  });

  // ── Scroll reveal animations (skip if reduced motion) ─────────────────
  var prefersReduced = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (!prefersReduced && 'IntersectionObserver' in window) {
    var reveal = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.style.opacity = '1';
          entry.target.style.transform = 'translateY(0)';
          reveal.unobserve(entry.target);
        }
      });
    }, { threshold: 0.08, rootMargin: '0px 0px -40px 0px' });

    document.querySelectorAll(
      '.feature-card, .step-card, .pricing-card, .testimonial-card, .why-card, .faq-item'
    ).forEach(function (el) {
      el.style.opacity = '0';
      el.style.transform = 'translateY(20px)';
      el.style.transition = 'opacity .6s ease, transform .6s ease';
      reveal.observe(el);
    });
  }

  // ── Close mobile nav on resize to desktop ──────────────────────────────
  var mqDesktop = window.matchMedia('(min-width: 769px)');
  var onMq = function (e) { if (e.matches) window.closeMobileNav(); };
  if (mqDesktop.addEventListener) mqDesktop.addEventListener('change', onMq);
  else if (mqDesktop.addListener) mqDesktop.addListener(onMq);
})();
