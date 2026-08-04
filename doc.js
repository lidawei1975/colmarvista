/**
 * doc.js - Shared interactive script for COLMARvista Documentation pages
 */

// Initialize theme immediately to prevent flash of wrong theme
(function initTheme() {
  const htmlElem = document.documentElement;
  const savedTheme = localStorage.getItem('colmar_doc_theme') || 'dark';
  htmlElem.setAttribute('data-theme', savedTheme);

  document.addEventListener('DOMContentLoaded', () => {
    const themeToggle = document.getElementById('theme-toggle');
    if (themeToggle) {
      themeToggle.addEventListener('click', () => {
        const currentTheme = htmlElem.getAttribute('data-theme');
        const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
        htmlElem.setAttribute('data-theme', newTheme);
        localStorage.setItem('colmar_doc_theme', newTheme);
      });
    }
  });
})();

// Initialize back-to-top, scrollspy navigation, and live search filtering
function initInteractiveDocFeatures() {
  const backToTop = document.getElementById('back-to-top');
  if (backToTop) {
    window.addEventListener('scroll', () => {
      if (window.scrollY > 400) {
        backToTop.classList.add('show');
      } else {
        backToTop.classList.remove('show');
      }
    });

    backToTop.addEventListener('click', () => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  const sections = document.querySelectorAll('section.doc-card, section.hero-banner');
  const navLinks = document.querySelectorAll('.nav-link');

  if (sections.length && navLinks.length) {
    window.addEventListener('scroll', () => {
      let current = '';
      sections.forEach(section => {
        const sectionTop = section.offsetTop - 100;
        if (window.scrollY >= sectionTop && section.style.display !== 'none') {
          current = section.getAttribute('id');
        }
      });

      navLinks.forEach(link => {
        link.classList.remove('active');
        const href = link.getAttribute('href');
        if (href === '#' + current || href.endsWith('#' + current)) {
          link.classList.add('active');
        }
      });
    });
  }

  const searchInput = document.getElementById('doc-search');
  const noResultsMsg = document.getElementById('no-results-msg');
  const docCards = document.querySelectorAll('.doc-card');
  const sectionHeaders = document.querySelectorAll('.section-divider-header');

  if (searchInput) {
    function performSearch() {
      const query = searchInput.value.toLowerCase().trim();
      let visibleCount = 0;

      docCards.forEach(card => {
        const id = card.getAttribute('id');
        const cardText = card.textContent.toLowerCase();
        const navLink = document.querySelector(`.nav-link[href*="#${id}"]`);

        if (query === '' || cardText.includes(query)) {
          card.style.display = 'block';
          if (navLink) navLink.style.display = 'block';
          visibleCount++;
        } else {
          card.style.display = 'none';
          if (navLink) navLink.style.display = 'none';
        }
      });

      sectionHeaders.forEach(header => {
        if (query === '') {
          header.style.display = 'block';
        } else {
          const nextElem = header.nextElementSibling;
          const containerCards = nextElem ? (nextElem.querySelectorAll('.doc-card').length ? nextElem.querySelectorAll('.doc-card') : [nextElem]) : [];
          const hasVisible = Array.from(containerCards).some(c => c.style.display !== 'none');
          header.style.display = hasVisible ? 'block' : 'none';
        }
      });

      if (noResultsMsg) {
        noResultsMsg.style.display = (visibleCount === 0 && query !== '') ? 'block' : 'none';
      }
    }

    searchInput.addEventListener('input', performSearch);
    searchInput.addEventListener('keyup', performSearch);
    searchInput.addEventListener('search', performSearch);
  }
}

// Auto-initialize for standalone documentation pages (doc_1d, doc_2d, doc_3d)
document.addEventListener('DOMContentLoaded', () => {
  if (!document.getElementById('docs-3d-container')) {
    initInteractiveDocFeatures();
  }
});
