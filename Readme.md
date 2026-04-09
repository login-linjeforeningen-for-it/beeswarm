# BeeSwarm

### Model
Run instructions
1. Add the following environment variables:
```
DB_PASSWORD=<enter_a_strong_password>
DB_HOST=beeswarm
API=https://beekeeper.login.no/api
```
2. `cd model`.
3. If you want to run natively using your GPU natively go to step 3, otherwise skip to step 4 to run in Docker.
4. Run `./run_model_mac.sh` or `./run_model_*` depending on your operating system.
5. To run it in Docker you can run `docker compose up --build`.

#### Modules
The models folder contain a modules folder which currently only supports access to the internet.
This is not implemented yet but only implemented as a theoretical utility. It should be fully implemented.

It can be started using `npm i` followed by `npm start`. Currently it only supports a single query hard coded in the `internet.ts`. This should be modified to allow for any query via the api, and the chatbot should be able to access this endpoint somehow.
