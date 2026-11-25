# Le P'tit Resto 29

Site du P'tit Resto 29 (burgers maison, Fouesnant) : carte, click & collect avec créneaux de retrait, réservation de table, espace client avec fidélité et back-office du restaurant.

Ce dépôt remplace l'hébergement ChatGPT Sites. L'interface est celle du site d'origine. Le serveur a été réécrit pour **Cloudflare Workers** (offre gratuite, usage commercial autorisé), avec une base **D1** (SQLite) et un espace **KV** pour les photos ajoutées depuis l'administration.

## Ce qui a été repris du site d'origine (25/11/2026)

- L'interface complète (HTML, CSS, JavaScript) : rendu identique.
- Les textes de la page d'accueil, la carte complète (42 produits avec prix et descriptions) et les 3 photos du carrousel.
- Les logos et les photos du restaurant, optimisés : environ 7 Mo d'images ramenés à 0,5 Mo, sans perte visible.

**Non récupérable depuis l'extérieur** : les comptes clients, l'historique des commandes et réservations, le compte administrateur et les réglages exacts des créneaux. Le compte admin se recrée avec `npm run admin:remote`. Les clients recréent leur compte. Les créneaux démarrent avec : mardi au vendredi, 12h–13h30 et 19h–21h, pas de 15 min, 1 réservation et 5 retraits par créneau. Tout se modifie dans l'administration.

## Différences avec l'original

- **Bug corrigé** : à l'ouverture de l'administration, le formulaire « Règles de disponibilité » affichait 5 minutes et aucun jour ouvert au lieu des vrais réglages. Un clic sur « Enregistrer » fermait alors le restaurant à la réservation.
- **Bug corrigé** : un burger ou une boisson ajouté depuis l'administration n'apparaissait ni sur la carte ni dans le click & collect. Il est maintenant rangé avec les burgers ou les softs.
- **Ajout** : un lien « Mentions légales et confidentialité » en bas de page. Il est obligatoire, car le site collecte nom, e-mail et téléphone des clients. **Compléter les champs surlignés** dans `public/mentions-legales.html`.
- **Polices** : la feuille de style d'origine prévoit Fraunces et DM Sans, mais son `@import` mal placé fait que ces polices n'étaient jamais chargées. Le rendu actuel, avec les polices du système, est conservé à l'identique.
- **E-mails de confirmation** : pas d'envoi d'e-mail pour l'instant (`notification.sent = false`). Il faudrait un service d'envoi (ex. Brevo ou Resend, offres gratuites), à décider.
- **Fidélité** : 1 point par euro, crédité quand une commande passe en « Retirée · payée sur place ».

## Structure

| Chemin | Rôle |
| --- | --- |
| `public/` | Interface (servie telle quelle) : `index.html`, `app.js`, `app.css`, images, page légale, en-têtes de sécurité (`_headers`) |
| `src/worker.js` | API : comptes, sessions, créneaux, commandes, réservations, administration, photos |
| `migrations/` | Schéma de la base et données de départ (contenu, carrousel, carte) |
| `scripts/create-admin.mjs` | Création du compte administrateur (le mot de passe n'est jamais stocké en clair) |
| `scripts/smoke-test.mjs` | Recette de bout en bout de l'API (61 contrôles), **uniquement en local** |

Sécurité : mots de passe hachés (PBKDF2-SHA256, 100 000 itérations), cookie de session `HttpOnly` / `Secure` / `SameSite=Lax`, refus des requêtes venant d'un autre site, limitation des tentatives de connexion (10 par e-mail, 30 par IP, sur 15 min), vérification du contenu réel des images envoyées, CSP stricte.

## Lancer en local

```bash
npm install
npm run db:migrate:local
npm run admin:local          # crée un compte admin local (e-mail + mot de passe demandés)
npm run dev                  # http://127.0.0.1:8787
ADMIN_EMAIL=… ADMIN_PASSWORD=… npm test   # recette, dans un second terminal
```

## Mettre en ligne sur Cloudflare (gratuit)

1. Créer un compte sur [dash.cloudflare.com](https://dash.cloudflare.com), puis : `npx wrangler login`.
2. Créer la base et l'espace photos :
   ```bash
   npx wrangler d1 create leptitresto29
   npx wrangler kv namespace create MEDIA
   ```
   Recopier les deux identifiants affichés dans `wrangler.jsonc` (`database_id` et `id`).
3. Initialiser la base en ligne et créer le compte admin :
   ```bash
   npm run db:migrate:remote
   npm run admin:remote
   ```
4. Publier : `npm run deploy`. Le site répond sur `https://leptitresto29.<votre-sous-domaine>.workers.dev`.
5. Nom de domaine (optionnel) : dans Cloudflare, *Workers & Pages → leptitresto29 → Settings → Domains & Routes → Add custom domain*.

Une fois le site en ligne et vérifié, le site ChatGPT Sites peut être arrêté.
