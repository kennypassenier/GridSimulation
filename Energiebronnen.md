# Energiebronnen

## Types

- Diesel
- Wind
- Nucleaire energie

## Services

Dit zijn allemaal services die gebruik maken van de ingebouwde http module. Eerst was dit een Express server, zowat de standaard in het land van NodeJS, maar dat was overkill voor een service met 3 routes. Omdat we geen dependencies gebruiken hoeven we ons ook geen zorgen te maken over potentiele beveiligingsproblemen in die dependencies. 

## Configuratie

We gebruiken environment variabelen, met constante waardes als backup. In principe kan elk type stroombron indien gewenst snel met andere waarden geconfigureerd worden. 