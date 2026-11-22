# Synapse en ligne (serveur seul, sans PC allumé). Voir METTRE-EN-LIGNE.txt.
#   docker build -t synapse .
#   docker run -d -p 8080:8080 -v synapse-donnees:/data -e SYNAPSE_URL_PUBLIQUE=https://synapse.ton-domaine.fr synapse
# Au premier démarrage, `docker logs` affiche la ligne « INSTALLATION » : ouvre ce lien pour créer ton compte créateur.
#
# L'application est déjà compilée dans dist/ (le lanceur du PC la met à jour à chaque lancement) :
# l'hébergeur n'a rien à installer ni à compiler, il lui faut seulement Node.js.

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080 SYNAPSE_DATA_DIR=/data
COPY dist ./dist
COPY scripts ./scripts
RUN test -f dist/index.html && mkdir -p /data && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1
CMD ["node", "scripts/serveur-public.mjs"]
