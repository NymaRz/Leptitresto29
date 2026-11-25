# Le P'tit Resto 29

Site vitrine du P'tit Resto 29, burgers maison à Fouesnant (5 rue de Kernévéleck, 29170).

Site **100 % statique** : HTML, CSS et un petit fichier JavaScript. Pas de build, pas de base de données, pas de dépendance. Il fonctionne sur n'importe quel hébergement de fichiers statiques et ne dépend plus de ChatGPT Sites.

## Contenu

| Fichier | Rôle |
| --- | --- |
| `index.html` | Page d'accueil : présentation, carte, terrasse, horaires, accès, contact |
| `mentions-legales.html` | Mentions légales (champs à compléter avant la mise en ligne) |
| `styles.css` | Mise en forme, ordinateur et mobile |
| `main.js` | Menu mobile, jour courant et statut « ouvert / fermé » (heure de Paris) |
| `assets/img/` | Photos du restaurant (WebP optimisé) et image de partage `og-image.jpg` |
| `assets/fonts/` | Police Bricolage Grotesque, hébergée localement (licence SIL OFL 1.1) |

Aucun cookie, aucun traceur, aucune ressource externe chargée : rien à déclarer côté RGPD.

## Lancer le site en local

```bash
python3 -m http.server 8029
# puis ouvrir http://localhost:8029
```

## Modifier les horaires

Les horaires apparaissent à trois endroits, à garder identiques :

1. le tableau `.hours` dans `index.html` (affichage) ;
2. l'objet `HORAIRES` dans `main.js` (badge « ouvert / fermé ») ;
3. le bloc `openingHoursSpecification` du JSON-LD dans `index.html` (Google).

## Hébergement

Deux solutions gratuites, au choix :

- **GitHub Pages** (le plus simple, le code est déjà ici) : *Settings → Pages → Build and deployment → Deploy from a branch → `main` / `(root)`*. Le site est alors servi sur `https://nymarz.github.io/Leptitresto29/`, et un nom de domaine (ex. `leptitresto29.fr`) peut y être branché.
- **Cloudflare Pages** : connecter ce dépôt, sans commande de build, dossier de sortie `/`. Usage commercial autorisé sur l'offre gratuite.

Une fois l'hébergeur choisi, compléter la rubrique « Hébergement » de `mentions-legales.html`.
