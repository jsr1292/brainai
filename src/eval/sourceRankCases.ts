// Each row is [question, owner statement, inference]. In each topic the other six facts serve as distractors.
// For agreement and conflict both texts answer the question. For the last two rows only the inference gives
// the requested detail, even though the owner statement is about the same subject.
type Pair = readonly [question: string, owner: string, inference: string];
interface Topic { project: string; agree: Pair; conflict: Pair; inferred: [Pair, Pair] }

export const topics: Topic[] = [
  {
    project: 'pottery',
    agree: ['What color glaze goes on the mugs?', 'The mugs get a blue glaze.', 'Blue is the glaze color for the mugs.'],
    conflict: ['Which shelf holds the drying bowls?', 'The drying bowls go on the lower shelf.', 'The drying bowls go on the upper shelf.'],
    inferred: [
      ['How many handles fit on the drying board?', 'The handles dry on a wooden board.', 'The drying board fits twelve handles.'],
      ['What is the kiln booking fee for guests?', 'Members pay ten coins to book the kiln.', 'Guests pay fifteen coins to book the kiln.'],
    ],
  },
  {
    project: 'orchard',
    agree: ['When are the pears picked?', 'Pears are picked in September.', 'September is the pear harvest month.'],
    conflict: ['Which trees border the path?', 'Plum trees border the path.', 'Apple trees border the path.'],
    inferred: [
      ['Which gate takes the harvest cart?', 'The heavy harvest cart has wide wheels.', 'The harvest cart fits through the west gate.'],
      ['How often are the young pear trees watered?', 'Mature pear trees get water every week.', 'Young pear trees get water twice a week.'],
    ],
  },
  {
    project: 'quilt',
    agree: ['Which thread is used for the border?', 'Cotton thread is used for the border.', 'The border is sewn with cotton thread.'],
    conflict: ['How wide are the binding strips?', 'The binding strips are two inches wide.', 'The binding strips are three inches wide.'],
    inferred: [
      ['Where are the spare bobbins stored?', 'The spare bobbins are wound with red thread.', 'Spare bobbins are stored in the tin.'],
      ['Which fabric backs the small quilt?', 'The large quilt has a linen backing.', 'The small quilt has a flannel backing.'],
    ],
  },
  {
    project: 'choir',
    agree: ['Where does the choir rehearse?', 'The choir rehearses in the chapel.', 'Choir practice takes place in the chapel.'],
    conflict: ['Which day is the spring concert?', 'The spring concert is on Friday.', 'The spring concert is on Sunday.'],
    inferred: [
      ['Who brings folders for the altos?', 'The altos use green folders.', 'The librarian brings folders for the altos.'],
      ['When do the tenors arrive for rehearsal?', 'Sopranos arrive at six for rehearsal.', 'Tenors arrive at seven for rehearsal.'],
    ],
  },
  {
    project: 'printing',
    agree: ['What ink is used on the posters?', 'The posters are printed with black ink.', 'Black ink is used for the posters.'],
    conflict: ['Which side of the card carries the stamp?', 'The stamp goes on the back of the card.', 'The stamp goes on the front of the card.'],
    inferred: [
      ['How many sheets go into a sample pack?', 'Sample packs contain textured sheets.', 'Each sample pack contains eight sheets.'],
      ['What paper weight is used for postcards?', 'Letters are printed on paper weighing ninety grams per square metre.', 'Postcards use paper weighing three hundred grams per square metre.'],
    ],
  },
  {
    project: 'theatre',
    agree: ['Where are the spare costumes kept?', 'Spare costumes are kept in the attic.', 'The attic is used to store the spare costumes.'],
    conflict: ['Which act uses the painted moon?', 'The painted moon appears in the second act.', 'The painted moon appears in the first act.'],
    inferred: [
      ['What color is the curtain for the matinee?', 'The matinee curtain is made of velvet.', 'The matinee uses the red curtain.'],
      ['How many chairs does the balcony hold?', 'The stalls hold forty chairs.', 'The balcony holds twenty chairs.'],
    ],
  },
  {
    project: 'bakery',
    agree: ['What flour goes into the rye loaf?', 'The rye loaf uses wholemeal flour.', 'Wholemeal is the flour in the rye loaf.'],
    conflict: ['How long does the dough rest?', 'The dough rests for thirty minutes.', 'The dough rests for sixty minutes.'],
    inferred: [
      ['How are the poppy rolls packaged?', 'The poppy rolls have a crisp crust.', 'Poppy rolls come in a paper sleeve.'],
      ['What shape is the small bread tin?', 'The large bread tin is rectangular.', 'The small bread tin is round.'],
    ],
  },
  {
    project: 'museum',
    agree: ['Where do visitors collect the audio guide?', 'Visitors collect the audio guide at reception.', 'Reception hands out audio guides to visitors.'],
    conflict: ['Which gallery houses the bronze masks?', 'The east gallery houses the bronze masks.', 'The west gallery houses the bronze masks.'],
    inferred: [
      ['When is the textile room open?', 'The textile room has a separate entrance.', 'The textile room is open on Saturdays.'],
      ['How many sketches are on loan?', 'Four paintings are on loan.', 'Six sketches are on loan.'],
    ],
  },
  {
    project: 'canoe',
    agree: ['Where do paddlers pick up the life jackets?', 'Paddlers pick up life jackets at the boathouse.', 'Life jackets for paddlers are collected at the boathouse.'],
    conflict: ['Which bank is the lunch stop on?', 'The lunch stop is on the left bank.', 'The lunch stop is on the right bank.'],
    inferred: [
      ['What is the rental price for a double canoe?', 'The double canoe has padded seats.', 'A double canoe rents for thirty coins.'],
      ['How long is the return paddle?', 'The outward paddle lasts three hours.', 'The return paddle lasts two hours.'],
    ],
  },
  {
    project: 'weaving',
    agree: ['Which fiber is used for the warp?', 'The warp uses linen fiber.', 'Linen is the fiber chosen for the warp.'],
    conflict: ['How many shuttles are kept at the loom?', 'Two shuttles are kept at the loom.', 'Three shuttles are kept at the loom.'],
    inferred: [
      ['What width is the blue ribbon?', 'The blue ribbon has a plain weave.', 'The blue ribbon is two centimetres wide.'],
      ['How many repeats go on the narrow scarf?', 'The wide scarf uses eight pattern repeats.', 'The narrow scarf uses four pattern repeats.'],
    ],
  },
];
