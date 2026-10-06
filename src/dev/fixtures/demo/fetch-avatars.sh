#!/bin/sh
# Fill demo/avatars/ with the demo's profile pictures. The folder is gitignored:
# these are photos of real people (randomuser.me portraits, made for
# placeholder use, and the presenter's own) and stay out of a public repo.
# Without them the demo falls back to initials discs.
set -e
cd "$(dirname "$0")"
mkdir -p avatars
fetch() { curl -fsSL -m 15 -o "avatars/$1.jpg" "https://randomuser.me/api/portraits/$2.jpg"; }
fetch maya women/90
fetch daniel men/5
fetch lucia women/47
fetch tom men/79
fetch priya women/22
fetch jonas men/52
fetch aisha women/75
fetch ethan men/22
# The presenter: pass a photo, or it defaults to ~/Documents/image.jpg.
cp "${1:-$HOME/Documents/image.jpg}" avatars/me.jpg
echo "avatars ready: $(ls avatars | tr '\n' ' ')"
