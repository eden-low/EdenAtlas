# EdenAtlas UI/UX Pro Max Audit

Staging audit, 2026-09-29. This is a source and design-system review, not a claim of device or authenticated-user testing. The EdenAtlas [brand book](brand-book.md) and [design system](design-system.md) take precedence over generic recommendations. Reviewed `styles.css`, `tailwind.config.js`, the shared sidebar/mobile navigation/splash/scripts/i18n modules, and Home, Connections (`dashboard.html`), Journal, Timeline, Calendar, Expenses, Me, Profile, Login, and Career (`resume.html`). [UI UX Pro Max](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) CLI `2.15.0` product, UX, and HTML/Tailwind guidance informed the findings.

## 1. Executive summary

Keep the calm dark canvas, one violet accent, system typography, and distinct page purposes. The best immediate gain is keyboard and small-screen navigation polish in shared UI. Data-dependent improvements need separate review; this phase must leave backend, auth, calendar integration, and business rules alone.

## 2. Existing strengths

- Brand and component rules are documented with exact colors, type stacks, spacing, and icon migration boundaries.
- Pages use a common shell, responsive containers, light-mode overrides, reduced-motion rules, and safe-area offsets.
- Journal, Journey, Finance, Career, and Connections already have human-written empty copy. Login has visible labels and an announced status region.
- Auth splash follows actual auth resolution, rather than imposing a decorative wait.

## 3. Existing inconsistencies

- Focus indicators depend on individual Tailwind classes. Some controls use `outline-none` with only a border-color change, while many buttons have no explicit focus treatment.
- The mobile bottom-nav label is hidden entirely under 390px, leaving icon-only links with no explicit accessible name.
- The desktop sidebar rows are roughly 40px high; documented mobile targets are 44px. Language controls are smaller still.
- Career uses multiple `h1` section headings while most other pages reserve `h1` for the page title. Legacy hidden headers still contain old icon and brand language, although they are not rendered.

## 4. UI UX Pro Max findings

The product catalog suggests Soft UI Evolution and minimalism for diary writing, dark restrained surfaces for personal finance, and document-oriented minimalism for a CV. UX rules emphasize visible keyboard focus, accessible icon controls, target spacing, readable long text, focus clearance around fixed bars, and reduced motion. These are decision inputs, not a replacement palette or a mandate to add charts, animation, or new fonts.

## 5. Recommendations compatible with EdenAtlas

| Recommendation | Priority | Classification |
|---|---|---|
| Add a shared skip-to-main link and a consistent, visible keyboard focus ring | P0 | SAFE UI-ONLY |
| Keep mobile navigation labels visible on narrow phones; enlarge shared sidebar hit areas | P0 | SAFE UI-ONLY |
| Make existing icon-only calendar month controls large enough and give them accessible names | P0 | SAFE UI-ONLY |
| Audit dialog focus entry, return, and inactive drawer tab stops in a dedicated interaction pass | P1 | SAFE UI-ONLY |
| Normalize Career heading levels and improve long-content wrapping where observed | P1 | SAFE UI-ONLY |
| Refine contextual loading and error copy only where existing state already distinguishes those outcomes | P1 | SAFE UI-ONLY |

## 6. Recommendations rejected because they conflict with EdenAtlas

Warm paper recoloring for Journal, finance-green brand accents, a new CV font, bright KPI tiles, neumorphic depth, neon/glow, extra glass layers, gamified progress, decorative 3D, and animation for its own sake conflict with the brand book. UI UX Pro Max's generic smooth-scroll or spring suggestions also lose to EdenAtlas's reduced-motion and restrained transition rules. No Google Fonts or new icon library is justified.

## 7. Global shell findings

`sidebar.js` and `mobile-nav.js` centralize navigation and expose current-page state. The hidden legacy headers create source duplication but do not present a visible inconsistency today. Shared focus and skip navigation solve a cross-page issue with minimal surface area. Preserve role-based link sets and all route behavior.

## 8. Home findings

`home.html` has a greeting-led overview, recent-memory empty treatment, contextual loading, and quick actions. Its broad surface can become dense on small screens; keep the greeting and personal material above utility shortcuts. Review data-failure feedback separately, without changing fetches or save paths.

## 9. Journal findings

The two-column list, writing action, mood/visibility filters, and inviting empty state support an editorial page. Search and filter controls are compact; provide clear focus and generous touch space. Long user prose should wrap naturally without truncation in a future content review. Keep Markdown sanitization and entry handling untouched.

## 10. Timeline findings

`timeline.html` has a clear chronological purpose and a human empty state. Preserve event order and density. Check long event titles and narrow-screen cards visually before altering templates; no timeline data or write behavior should change here.

## 11. Calendar findings

The month label is the page heading and the seven-column layout is utility-first. Prev/next controls are 36px and icon-only without accessible names. Increase their target to 44px and label them. Do not change event aggregation, date arithmetic, or Google Calendar integration.

## 12. Expenses findings

`expenses.html` keeps records and chart presentation restrained, with a useful first-expense empty line. Preserve tabular financial clarity and avoid giant KPI cards. A future review should check amount alignment, chart labels, and small-screen rows against actual populated data; receipt, currency, and persistence behavior are out of scope.

## 13. Career findings

`resume.html` uses a document-like reading surface, section navigation, and existing skeleton/empty states. Multiple section-level `h1` elements weaken the outline; standardize to one page `h1` and section `h2` after checking print styles and selectors. Preserve privacy controls and CV data flow.

## 14. Profile/Me findings

`me.html` already handles long profile strings with wrapping and makes its many tabs horizontally scrollable. `profile.html` separates public material and has a photo empty state. The many Me tabs deserve a keyboard overflow/discovery review with real content, while account/visibility semantics stay unchanged.

## 15. Login findings

`login.html` uses one focused card, visible email/password labels, autocomplete, and a live status region. Inputs remove the native outline and rely on a border change; the shared focus ring should restore a strong keyboard indicator. Do not modify sign-in, verification, linking, or account recovery logic.

## 16. Mobile UX findings

Top and bottom bars account for safe areas and body clearance. Below 390px, CSS hides all bottom-nav labels: this sacrifices recognition and accessible names. Keep labels visible, allowing truncation visually while preserving the full text in the DOM. The drawer has 44px link rows; verify focus management separately.

## 17. Accessibility findings

The shared shell lacks a skip-to-main link. Focus visibility varies by component, and fixed bars need scroll padding so focused controls remain visible. Icon-only calendar arrows need names. Color contrast and modal keyboard behavior require browser-based checks in both themes; source inspection alone cannot certify WCAG conformance.

## 18. Typography findings

System font stacks align with the brand. Small code-style metadata at 9–11px appears in navigation and labels; reserve it for nonessential metadata and test text scaling. Keep Journal prose more spacious than Calendar controls and Finance figures. Do not introduce webfonts.

## 19. Spacing/layout findings

Existing `p-4`/`p-5`/`p-6`, `space-y-6`, and page-specific max-widths form a coherent rhythm. Retain different widths for writing, utility, and document pages. Raise small operable targets without expanding every card or changing content hierarchy.

## 20. Motion/interaction findings

Reveal, splash, modal, and drawer effects have reduced-motion handling. Maintain short causal transitions. The broader `.reveal` entrance is longer than the brand's 150–300ms first-impression guidance; assess with actual page navigation before changing it. Preserve interaction semantics and avoid new parallax or gamified feedback.

## 21. Loading/empty/error-state findings

Several pages already have warm empty messages; Career has skeletons, Home has contextual loading, and Login has a live status. Do not add generic skeletons everywhere. Separate empty and failed-load states only where existing UI state supports the distinction. Retry behavior that changes fetch logic needs review.

## 22. Component consistency findings

Lucide is the standard for new surfaces; Font Awesome remains in legacy surfaces. Avoid mixed icon styles within one component. Shared navigation and CSS should carry changes first. Legacy hidden header markup and page-level repeated controls are technical cleanup candidates, but broad removal needs regression review.

## 23. Information-density findings

Home is overview-oriented, Journal prose-led, Journey chronological, Calendar compact, Finance precise, Career document-oriented, Login singular. Do not flatten them into one card template. Connections is a social utility page rather than an analytics dashboard despite its `dashboard.html` filename.

## 24. Prioritized implementation plan

| Step | Priority | Classification | Phase decision |
|---|---|---|---|
| Shared skip link, focus ring, focus scroll clearance | P0 | SAFE UI-ONLY | Implement in staging |
| Narrow-phone bottom labels and shared sidebar touch areas | P0 | SAFE UI-ONLY | Implement in staging |
| Calendar arrow targets and names | P0 | SAFE UI-ONLY | Implement in staging |
| Dialog/drawer keyboard-focus audit with browser and screen reader | P1 | SAFE UI-ONLY | Propose; needs interactive QA |
| Career semantic heading cleanup with print verification | P1 | SAFE UI-ONLY | Propose |
| Real-data reviews of overflow, charts, states, and light-mode contrast | P1 | SAFE UI-ONLY | Propose |
| Reduce legacy hidden-header duplication and normalize icon styling gradually | P2 | SAFE UI-ONLY | Propose |
| Add an unavailable/retry state where a page currently conflates query failure and no data | P1 | REQUIRES BACKEND / BUSINESS LOGIC REVIEW | Do not implement this phase |
| Change role visibility, expense calculations, calendar sync, or write behavior to support a design concept | P2 | REQUIRES BACKEND / BUSINESS LOGIC REVIEW | Reject for this phase |

Priority means P0 foundational/high impact, P1 important polish, P2 optional refinement. `SAFE UI-ONLY` marks presentation changes with no data, auth, API, or business behavior change. Every item requiring backend/business logic review is excluded from implementation.
