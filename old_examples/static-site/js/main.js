/**
 * Telos Spark — Main JavaScript
 * Premium interactions and animations
 */

(function() {
  'use strict';

  // ═══════════════════════════════════════════════════════════════════════════
  // MOBILE NAVIGATION
  // ═══════════════════════════════════════════════════════════════════════════

  const navToggle = document.querySelector('[data-nav-toggle]');
  const nav = document.querySelector('[data-nav]');

  if (navToggle && nav) {
    navToggle.addEventListener('click', () => {
      const isOpen = nav.classList.toggle('is-open');
      navToggle.setAttribute('aria-expanded', isOpen);
    });

    // Close nav when clicking outside
    document.addEventListener('click', (e) => {
      if (nav.classList.contains('is-open') && 
          !nav.contains(e.target) && 
          !navToggle.contains(e.target)) {
        nav.classList.remove('is-open');
        navToggle.setAttribute('aria-expanded', 'false');
      }
    });

    // Close nav on escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && nav.classList.contains('is-open')) {
        nav.classList.remove('is-open');
        navToggle.setAttribute('aria-expanded', 'false');
        navToggle.focus();
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // REVEAL ON SCROLL
  // ═══════════════════════════════════════════════════════════════════════════

  const revealElements = document.querySelectorAll('[data-reveal]');

  if (revealElements.length > 0) {
    const revealObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            // Small delay for staggered effect
            const delay = parseInt(entry.target.dataset.revealDelay) || 0;
            setTimeout(() => {
              entry.target.classList.add('is-revealed');
            }, delay);
            revealObserver.unobserve(entry.target);
          }
        });
      },
      {
        threshold: 0.1,
        rootMargin: '0px 0px -60px 0px'
      }
    );

    revealElements.forEach((el) => revealObserver.observe(el));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CARD HOVER GLOW EFFECT (Mouse tracking)
  // ═══════════════════════════════════════════════════════════════════════════

  const cards = document.querySelectorAll('.card');

  cards.forEach((card) => {
    card.addEventListener('mousemove', (e) => {
      const rect = card.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * 100;
      const y = ((e.clientY - rect.top) / rect.height) * 100;
      card.style.setProperty('--mouse-x', `${x}%`);
      card.style.setProperty('--mouse-y', `${y}%`);
    });

    card.addEventListener('mouseleave', () => {
      card.style.setProperty('--mouse-x', '50%');
      card.style.setProperty('--mouse-y', '0%');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SMOOTH SCROLL FOR ANCHOR LINKS
  // ═══════════════════════════════════════════════════════════════════════════

  document.querySelectorAll('a[href^="#"]').forEach((anchor) => {
    anchor.addEventListener('click', function(e) {
      const targetId = this.getAttribute('href');
      if (targetId === '#') return;
      
      const target = document.querySelector(targetId);
      if (target) {
        e.preventDefault();
        const headerHeight = document.querySelector('.header')?.offsetHeight || 0;
        const targetPosition = target.getBoundingClientRect().top + window.scrollY - headerHeight - 24;
        
        window.scrollTo({
          top: targetPosition,
          behavior: 'smooth'
        });

        // Update URL without jumping
        history.pushState(null, null, targetId);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // HEADER BACKGROUND ON SCROLL
  // ═══════════════════════════════════════════════════════════════════════════

  const header = document.querySelector('.header');
  
  if (header) {
    let lastScroll = 0;
    
    window.addEventListener('scroll', () => {
      const currentScroll = window.scrollY;
      
      // Add/remove scrolled class for enhanced styling
      if (currentScroll > 50) {
        header.classList.add('is-scrolled');
      } else {
        header.classList.remove('is-scrolled');
      }
      
      lastScroll = currentScroll;
    }, { passive: true });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FOCUS VISIBLE POLYFILL (for older browsers)
  // ═══════════════════════════════════════════════════════════════════════════

  // Add keyboard-user class when Tab is pressed
  document.body.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      document.body.classList.add('keyboard-user');
    }
  });

  // Remove keyboard-user class on mouse click
  document.body.addEventListener('mousedown', () => {
    document.body.classList.remove('keyboard-user');
  });

})();
