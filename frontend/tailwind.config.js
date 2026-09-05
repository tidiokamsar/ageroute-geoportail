/** @type {import('tailwindcss').Config} */
export default {
    darkMode: ["class"],
    content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
  	extend: {
  		colors: {
  			navy: '#1a2942',
  			navy2: '#22344e',
  			gold: '#f5a623',
  			background: 'var(--background)',
  			foreground: 'var(--foreground)',
  			card: {
  				DEFAULT: 'var(--card)',
  				foreground: 'var(--card-foreground)'
  			},
  			popover: {
  				DEFAULT: 'var(--popover)',
  				foreground: 'var(--popover-foreground)'
  			},
  			primary: {
  				DEFAULT: 'var(--primary)',
  				foreground: 'var(--primary-foreground)'
  			},
  			secondary: {
  				DEFAULT: 'var(--secondary)',
  				foreground: 'var(--secondary-foreground)'
  			},
  			muted: {
  				DEFAULT: 'var(--muted)',
  				foreground: 'var(--muted-foreground)'
  			},
  			accent: {
  				DEFAULT: 'var(--accent)',
  				foreground: 'var(--accent-foreground)'
  			},
  			destructive: 'var(--destructive)',
  			border: 'var(--border)',
  			input: 'var(--input)',
  			ring: 'var(--ring)',
  			chart: {
  				'1': 'var(--chart-1)',
  				'2': 'var(--chart-2)',
  				'3': 'var(--chart-3)',
  				'4': 'var(--chart-4)',
  				'5': 'var(--chart-5)'
  			},
  			sidebar: {
  				DEFAULT: 'var(--sidebar)',
  				foreground: 'var(--sidebar-foreground)',
  				primary: 'var(--sidebar-primary)',
  				'primary-foreground': 'var(--sidebar-primary-foreground)',
  				accent: 'var(--sidebar-accent)',
  				'accent-foreground': 'var(--sidebar-accent-foreground)',
  				border: 'var(--sidebar-border)',
  				ring: 'var(--sidebar-ring)'
  			},
  			// Echelle d'etat du reseau. Source unique : features/geoportail/map/symbology.ts
  			// pour le canvas Leaflet, styles/tokens.css pour le DOM ; un test compare les deux.
  			// Utiliser `text-etat-bon`, `bg-etat-bon-fond`, `border-etat-bon` — jamais un hexa.
  			etat: {
  				bon: { DEFAULT: 'var(--etat-bon-texte)', trait: 'var(--etat-bon-trait)', fond: 'var(--etat-bon-fond)' },
  				moyen: { DEFAULT: 'var(--etat-moyen-texte)', trait: 'var(--etat-moyen-trait)', fond: 'var(--etat-moyen-fond)' },
  				mauvais: { DEFAULT: 'var(--etat-mauvais-texte)', trait: 'var(--etat-mauvais-trait)', fond: 'var(--etat-mauvais-fond)' },
  				critique: { DEFAULT: 'var(--etat-critique-texte)', trait: 'var(--etat-critique-trait)', fond: 'var(--etat-critique-fond)' },
  				inconnu: { DEFAULT: 'var(--etat-inconnu-texte)', trait: 'var(--etat-inconnu-trait)', fond: 'var(--etat-inconnu-fond)' }
  			},
  			// Semantiques d'interface, distinctes de l'etat du reseau : une erreur
  			// applicative et une route degradee ne disent pas la meme chose.
  			succes: 'var(--succes)',
  			avertissement: 'var(--avertissement)',
  			danger: 'var(--danger)',
  			info: 'var(--info)'
  		},
  		borderRadius: {
  			lg: 'var(--radius)',
  			md: 'calc(var(--radius) - 2px)',
  			sm: 'calc(var(--radius) - 4px)',
  			// Rayons du systeme (styles/tokens.css). Les trois ci-dessus restent
  			// pour shadcn, qui les attend sous ces noms.
  			'jeton-sm': 'var(--rayon-sm)',
  			'jeton-md': 'var(--rayon-md)',
  			'jeton-lg': 'var(--rayon-lg)'
  		},
  		spacing: {
  			'j1': 'var(--espace-1)', 'j2': 'var(--espace-2)', 'j3': 'var(--espace-3)',
  			'j4': 'var(--espace-4)', 'j5': 'var(--espace-5)', 'j6': 'var(--espace-6)',
  			'j7': 'var(--espace-7)', 'j8': 'var(--espace-8)',
  			// Planchers de cible tactile : WCAG 2.5.5, et le mode terrain.
  			'cible': 'var(--cible-min)', 'cible-terrain': 'var(--cible-terrain)'
  		},
  		boxShadow: {
  			'n1': 'var(--ombre-1)', 'n2': 'var(--ombre-2)', 'n3': 'var(--ombre-3)'
  		},
  		// Nommes plutot que numeriques : `z-panneau` dit ce qu'il fait, `z-[900]` non.
  		// Ils demarrent au-dessus des 800 que Leaflet pose en dur sur ses controles.
  		zIndex: {
  			'carte': 'var(--z-carte)', 'controles-carte': 'var(--z-controles-carte)',
  			'panneau': 'var(--z-panneau)', 'surcouche': 'var(--z-surcouche)',
  			'modale': 'var(--z-modale)', 'toast': 'var(--z-toast)'
  		},
  		transitionDuration: {
  			'rapide': 'var(--duree-rapide)', 'normale': 'var(--duree-normale)',
  			'lente': 'var(--duree-lente)'
  		},
  		transitionTimingFunction: { 'jeton': 'var(--courbe)' },
  		fontFamily: {
  			sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif']
  		},
  		fontSize: {
  			// Echelle typographique : taille / interligne.
  			'titre': ['20px', '28px'], 'section': ['16px', '24px'],
  			'corps': ['14px', '20px'], 'legende': ['12px', '16px']
  		}
  	}
  },
  plugins: [require("tailwindcss-animate")],
};
