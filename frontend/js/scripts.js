// Shared keyboard shortcut to the primary content of each page.
document.addEventListener('DOMContentLoaded', () => {
  const main = document.querySelector('main');
  if (!main || document.querySelector('.eden-skip-link')) return;
  if (!main.id) main.id = 'eden-main-content';
  main.setAttribute('tabindex', '-1');
  const skip = document.createElement('a');
  skip.className = 'eden-skip-link';
  skip.href = `#${main.id}`;
  skip.setAttribute('data-i18n', 'common.skip_to_content');
  skip.textContent = 'Skip to content';
  document.body.prepend(skip);
  window.EdenI18n?.init().then(() => window.EdenI18n.applyTranslations(document));
});

document.addEventListener('DOMContentLoaded', () => {
  const revealEls = document.querySelectorAll('.reveal');
  if (!revealEls.length) return;

  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (prefersReducedMotion) {
    revealEls.forEach((el) => el.classList.add('is-visible'));
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.15, rootMargin: '0px 0px -60px 0px' }
  );

  revealEls.forEach((el) => observer.observe(el));
});

document.addEventListener('DOMContentLoaded', () => {
  const hero = document.querySelector('[data-parallax-hero]');
  const layer = document.querySelector('[data-parallax-layer]');
  if (!hero || !layer) return;

  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (prefersReducedMotion) return;

  const maxTilt = 6;

  hero.addEventListener('mousemove', (event) => {
    const rect = hero.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width - 0.5;
    const y = (event.clientY - rect.top) / rect.height - 0.5;
    layer.style.transform = `perspective(1000px) rotateX(${(-y * maxTilt).toFixed(2)}deg) rotateY(${(x * maxTilt).toFixed(2)}deg) scale(1.05)`;
  });

  hero.addEventListener('mouseleave', () => {
    layer.style.transform = 'perspective(1000px) rotateX(0deg) rotateY(0deg) scale(1)';
  });
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch(console.error);
  });
}
