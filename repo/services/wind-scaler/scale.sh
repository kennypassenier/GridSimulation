#!/bin/sh
# Wordt aangemaakt door een Cronjob
# Zet enkel het aantal replicas van wind-farm op de gewenste waarde. 
# Daarna stopt de pod.

# Kubectl was hier ook een optie, maar voor die ene API call leek het overkill.
# Ook hier hebben we liever geen dependencies.

# Stop onmiddelijk bij een fout
set -e
# Koppel dezelfde ServiceAccount als in de grid-controller
SA=/var/run/secrets/kubernetes.io/serviceaccount

# Fail-with-body geeft foutstatus bij HTTP 4xx/5xx
# Standaard zou 403 anders als geslaagd aangegeven worden.
# Maar toont toch het antwoord, kwestie van de reden te kunnen zien.
curl -sS --fail-with-body \
  --cacert $SA/ca.crt \
  -H "Authorization: Bearer $(cat $SA/token)" \
  -H "Content-Type: application/merge-patch+json" \
  -X PATCH \
  "https://$KUBERNETES_SERVICE_HOST:$KUBERNETES_SERVICE_PORT/apis/apps/v1/namespaces/$(cat $SA/namespace)/deployments/wind-farm/scale" \
  -d "{\"spec\":{\"replicas\":$REPLICAS}}" > /dev/null

# Verschijnt in kubectl logs -n grid job/<naam>
echo "wind-farm scaled to $REPLICAS"